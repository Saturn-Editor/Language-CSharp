/**
 * csharp-ls lives in the module's storage folder, installed with `dotnet tool install --tool-path`
 * (no global install, PATH changes or admin rights).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dotnetCommand, dotnetEnv } from './dotnet.js';

export const toolsDir = (storagePath) => join(storagePath, 'tools');

export const binaryPath = (storagePath) => join(toolsDir(storagePath), process.platform === 'win32' ? 'csharp-ls.exe' : 'csharp-ls');

export const isInstalled = (storagePath) => existsSync(binaryPath(storagePath));

const pending = new Map(); // storagePath → install promise

const STALE_LOCK_MS = 5 * 60 * 1000;

/** Takes the cross-process install lock (an atomic mkdir), waiting while another process holds it. */
export async function acquireLock(storagePath, name = 'tools') {
  const lock = join(storagePath, `${name}.installing`);
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between mkdir and stat
      }
      if (age > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Installs csharp-ls into storage, or updates it when `update` is set. Concurrent calls share one run.
 * @returns {Promise<{ ok: boolean, output: string, missingDotnet?: boolean }>}
 */
export function install(storagePath, { update = false, onOutput } = {}) {
  if (pending.has(storagePath)) return pending.get(storagePath);
  const run = (async () => {
    const release = await acquireLock(storagePath);
    try {
      // Another process may have installed it while we waited.
      if (!update && isInstalled(storagePath)) return { ok: true, output: '' };
      return await runTool(storagePath, update && isInstalled(storagePath) ? 'update' : 'install', onOutput);
    } finally {
      release();
    }
  })().finally(() => pending.delete(storagePath));
  pending.set(storagePath, run);
  return run;
}

function runTool(storagePath, verb, onOutput) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(dotnetCommand(), ['tool', verb, 'csharp-ls', '--tool-path', toolsDir(storagePath)], {
      env: dotnetEnv({ DOTNET_CLI_TELEMETRY_OPTOUT: '1' }),
    });
    const collect = (chunk) => {
      output += chunk;
      onOutput?.(chunk.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => resolve({ ok: false, output: String(e.message), missingDotnet: e.code === 'ENOENT' }));
    child.on('close', (code) => resolve({ ok: code === 0 && isInstalled(storagePath), output }));
  });
}
