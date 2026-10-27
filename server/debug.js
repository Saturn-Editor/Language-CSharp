/**
 * Debug adapter for Saturn: a DAP proxy in front of netcoredbg. On `launch` without a `program`, it builds
 * the startup project and fills in its output assembly. netcoredbg comes from argv[2] when set, otherwise
 * from module storage (downloaded on first use).
 */
import { spawn } from 'node:child_process';
import { binaryPath, install, isInstalled } from '../lib/netcoredbg.js';
import { runTarget } from '../lib/dotnet.js';

const configured = (process.argv[2] ?? '').trim();
const storage = process.env.SATURN_MODULE_STORAGE;

/** Splits a DAP byte stream (Content-Length framed JSON) into messages. */
function framer(onMessage) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + length) return;
      onMessage(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
      buffer = buffer.subarray(end + 4 + length);
    }
  };
}

const encode = (message) => {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};

let seq = 1_000_000; // well clear of the adapter's own sequence numbers
const toClient = (message) => process.stdout.write(encode({ seq: seq++, ...message }));
const output = (text, category = 'console') => toClient({ type: 'event', event: 'output', body: { category, output: text } });
const fail = (request, message) =>
  toClient({ type: 'response', request_seq: request.seq, command: request.command, success: false, message, body: { error: { id: 1, format: message } } });

function dotnet(args, cwd, onText) {
  return new Promise((resolve) => {
    let text = '';
    const child = spawn('dotnet', args, { cwd, env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', DOTNET_NOLOGO: '1' } });
    const collect = (c) => {
      text += c;
      onText?.(c.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => resolve({ code: null, text: e.message }));
    child.on('close', (code) => resolve({ code, text }));
  });
}

/** Builds the startup project and returns the launch arguments netcoredbg needs. */
async function prepareLaunch(args) {
  const { project: startup, ...rest } = args;
  if (rest.program) return rest;
  const root = rest.cwd || process.cwd();
  const project = await runTarget(root, startup || undefined);
  if (!project) throw new Error('No runnable project found. Set a startup project in the C# settings.');
  output(`Building ${project}…\n`);
  const built = await dotnet(['build', project, '-c', 'Debug', '-nologo', '-consoleLoggerParameters:NoSummary'], root, (t) => output(t, 'stdout'));
  if (built.code !== 0) throw new Error('Build failed. See the debug console for errors.');
  const target = await dotnet(['msbuild', project, '-nologo', '-getProperty:TargetPath', '-p:Configuration=Debug'], root);
  const program = target.text.trim().split(/\r?\n/).pop()?.trim();
  if (target.code !== 0 || !program) throw new Error(`Could not find the built assembly for ${project}.`);
  return { ...rest, program };
}

async function resolveAdapter() {
  if (configured) return configured;
  if (!storage) throw new Error('SATURN_MODULE_STORAGE is not set; set "netcoredbg location" in the C# settings.');
  if (!isInstalled(storage)) {
    process.stderr.write('[csharp] Downloading netcoredbg…\n');
    const result = await install(storage, { onOutput: (t) => process.stderr.write(t) });
    if (!result.ok) throw new Error(result.message);
  }
  return binaryPath(storage);
}

process.stdout.on('error', () => process.exit(0)); // client went away

let adapter = null;
let startError = null;
const ready = resolveAdapter().then(
  (path) => {
    adapter = spawn(path, ['--interpreter=vscode'], { stdio: ['pipe', 'pipe', 'inherit'] });
    adapter.stdout.on('data', framer((m) => process.stdout.write(encode(m))));
    adapter.on('error', (e) => {
      startError = `Could not start netcoredbg: ${e.message}`;
      process.stderr.write(`[csharp] ${startError}\n`);
    });
    adapter.on('exit', (code) => process.exit(code ?? 0));
  },
  (e) => {
    startError = e.message;
    process.stderr.write(`[csharp] ${startError}\n`);
  },
);

// Requests are handled in order so a launch that's still building doesn't get overtaken.
let queue = Promise.resolve();
process.stdin.on(
  'data',
  framer((message) => {
    queue = queue.then(async () => {
      await ready;
      if (startError || !adapter) {
        if (message.type === 'request') fail(message, startError ?? 'netcoredbg is not running.');
        if (message.command === 'disconnect') process.exit(0);
        return;
      }
      if (message.type === 'request' && message.command === 'launch') {
        try {
          message = { ...message, arguments: await prepareLaunch(message.arguments ?? {}) };
        } catch (e) {
          return fail(message, e.message);
        }
      }
      adapter.stdin.write(encode(message));
    });
  }),
);
process.stdin.on('end', () => adapter?.kill());
