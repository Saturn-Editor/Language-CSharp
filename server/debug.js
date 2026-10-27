/**
 * Debug adapter for Saturn: a DAP proxy in front of netcoredbg. On `launch` without a `program`, it builds
 * the startup project and fills in its output assembly. With "console": "integratedTerminal" it runs the
 * program in Saturn's terminal via runInTerminal (so it can read input) and attaches to it, since netcoredbg
 * can't do that itself. netcoredbg comes from argv[2] when set, otherwise from module storage (downloaded on
 * first use).
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listenForRuntime } from '../lib/diagport.js';
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
let supportsRunInTerminal = false;
const reverseRequests = new Map(); // our seq → resolve, for requests we send the client
const renamedResponses = new Map(); // request seq → command the client asked for (launch sent on as attach)

function fromAdapter(message) {
  if (message.type === 'response' && renamedResponses.has(message.request_seq)) {
    message = { ...message, command: renamedResponses.get(message.request_seq) };
    renamedResponses.delete(message.request_seq);
  }
  process.stdout.write(encode(message));
}

/**
 * Builds the startup hook (server/hook) into module storage on first use and returns its path. It holds the
 * program before Main until the debugger attaches.
 */
async function startupHook() {
  if (!storage) throw new Error('SATURN_MODULE_STORAGE is not set.');
  const dir = join(storage, 'debug-hook');
  const dll = join(dir, 'bin', 'SaturnDebugHook.dll');
  const source = new URL('./hook/', import.meta.url);
  const files = ['StartupHook.cs', 'SaturnDebugHook.csproj'];
  const current = existsSync(dll) && files.every((f) => existsSync(join(dir, 'src', f)) && readFileSync(join(dir, 'src', f), 'utf8') === readFileSync(new URL(f, source), 'utf8'));
  if (current) return dll;
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of files) copyFileSync(new URL(f, source), join(dir, 'src', f));
  output('Preparing the debugger for terminal input…\n');
  const built = await dotnet(['build', join(dir, 'src', 'SaturnDebugHook.csproj'), '-c', 'Release', '-nologo', '-o', join(dir, 'bin')], dir);
  if (built.code !== 0 || !existsSync(dll)) throw new Error(`building the startup hook failed\n${built.text.trim().split(/\r?\n/).slice(-3).join('\n')}`);
  return dll;
}

function requestClient(command, args) {
  const id = seq;
  toClient({ type: 'request', command, arguments: args });
  return new Promise((resolve) => reverseRequests.set(id, resolve));
}

/**
 * Starts the program in Saturn's terminal so it can read input, held before Main by the startup hook, and turns
 * the launch into an attach to it (netcoredbg can't run a program in a terminal itself). The diagnostic port
 * tells us its PID. Returns the attach request, or null to fall back to a plain launch.
 */
async function launchInTerminal(request, args) {
  let port = null;
  try {
    const hook = await startupHook();
    port = await listenForRuntime();
    const response = await requestClient('runInTerminal', {
      kind: 'integrated',
      title: basename(args.program, '.dll'),
      cwd: args.cwd || dirname(args.program),
      args: ['dotnet', args.program, ...(args.args ?? [])],
      env: { ...(args.env ?? {}), ...port.env, DOTNET_STARTUP_HOOKS: hook },
    });
    if (!response.success) throw new Error(response.message || 'runInTerminal failed.');
    const processId = await port.pid;
    port.close();
    renamedResponses.set(request.seq, request.command);
    const { program, args: _args, env: _env, cwd: _cwd, console: _console, stopAtEntry: _stop, ...rest } = args;
    return { ...request, command: 'attach', arguments: { ...rest, request: 'attach', processId } };
  } catch (e) {
    port?.close();
    output(`Could not start in the terminal (${e.message}); using the debug console instead.\n`);
    return null;
  }
}

const ready = resolveAdapter().then(
  (path) => {
    adapter = spawn(path, ['--interpreter=vscode'], { stdio: ['pipe', 'pipe', 'inherit'] });
    adapter.stdout.on('data', framer(fromAdapter));
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
    // Replies to our own requests skip the queue: the launch waiting on them holds it.
    if (message.type === 'response' && reverseRequests.has(message.request_seq)) {
      reverseRequests.get(message.request_seq)(message);
      reverseRequests.delete(message.request_seq);
      return;
    }
    if (message.type === 'request' && message.command === 'initialize') {
      supportsRunInTerminal = message.arguments?.supportsRunInTerminalRequest === true;
    }
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
        // netcoredbg can't run the program in a terminal itself, so start it there and attach.
        if (message.arguments.console === 'integratedTerminal' && supportsRunInTerminal) {
          message = (await launchInTerminal(message, message.arguments)) ?? message;
        }
      }
      adapter.stdin.write(encode(message));
    });
  }),
);
process.stdin.on('end', () => adapter?.kill());
