/**
 * Starts csharp-ls for Saturn: the user's configured binary if set (argv[2]), otherwise the copy in module
 * storage, downloading it first when missing. stdout belongs to LSP, so progress goes to stderr.
 */
import { spawn } from 'node:child_process';
import { binaryPath, install, isInstalled } from '../lib/csharpls.js';

const configured = (process.argv[2] ?? '').trim();
const storage = process.env.SATURN_MODULE_STORAGE;

async function resolveBinary() {
  if (configured && !configured.startsWith('${')) return configured;
  if (!storage) throw new Error('SATURN_MODULE_STORAGE is not set; set "csharp-ls location" in the C# settings.');
  if (!isInstalled(storage)) {
    process.stderr.write('[csharp] Downloading csharp-ls…\n');
    const result = await install(storage, { onOutput: (text) => process.stderr.write(text) });
    if (!result.ok) {
      throw new Error(result.missingDotnet ? 'The .NET SDK was not found. Install it from https://dotnet.microsoft.com/download' : `Installing csharp-ls failed.\n${result.output}`);
    }
  }
  return binaryPath(storage);
}

try {
  const child = spawn(await resolveBinary(), process.argv.slice(3), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (e) => {
    process.stderr.write(`[csharp] Could not start csharp-ls: ${e.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} catch (e) {
  process.stderr.write(`[csharp] ${e.message}\n`);
  process.exit(1);
}
