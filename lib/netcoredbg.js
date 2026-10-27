/**
 * netcoredbg (Samsung's open-source .NET debug adapter), downloaded from its GitHub releases into module
 * storage. Builds exist for Windows x64, Linux x64/arm64 and Apple Silicon; elsewhere (e.g. Intel Macs) set a
 * self-built copy in the settings.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock } from './csharpls.js';

const RELEASES = 'https://github.com/Samsung/netcoredbg/releases/latest/download/';

const buildFromSource = () =>
  `netcoredbg has no build for ${process.platform}-${process.arch}. Build it from https://github.com/Samsung/netcoredbg and set "netcoredbg location" in the C# settings.`;

/** The release asset for this machine, or null when there is none. */
export function assetName(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'netcoredbg-win64.zip';
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `netcoredbg-linux-${arch === 'x64' ? 'amd64' : 'arm64'}.tar.gz`;
  if (platform === 'darwin' && arch === 'arm64') return 'netcoredbg-osx-arm64.zip';
  return null;
}

const installDir = (storagePath) => join(storagePath, 'netcoredbg');

// The archives unpack to netcoredbg/netcoredbg[.exe].
export const binaryPath = (storagePath) => join(installDir(storagePath), 'netcoredbg', process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg');

export const isInstalled = (storagePath) => existsSync(binaryPath(storagePath));

const run = (command, args, cwd) =>
  new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd });
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', (e) => resolve({ code: null, output: e.message }));
    child.on('close', (code) => resolve({ code, output }));
  });

/** Downloads and unpacks netcoredbg. @returns {Promise<{ ok: boolean, message?: string }>} */
export async function install(storagePath, { onOutput } = {}) {
  const asset = assetName();
  if (!asset) return { ok: false, message: buildFromSource() };
  const release = await acquireLock(storagePath, 'netcoredbg');
  try {
    if (isInstalled(storagePath)) return { ok: true };
    const dir = installDir(storagePath);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    onOutput?.(`Downloading ${asset}…\n`);
    const response = await fetch(RELEASES + asset).catch((e) => ({ ok: false, statusText: e.message }));
    if (!response.ok) return { ok: false, message: `Downloading netcoredbg failed: ${response.status ?? ''} ${response.statusText}`.trim() };
    const archive = join(dir, asset);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    // bsdtar (macOS, Windows 10+) reads the zips; GNU tar on Linux gets the .tar.gz.
    const unpacked = await run('tar', [asset.endsWith('.zip') ? '-xf' : '-xzf', archive], dir);
    rmSync(archive, { force: true });
    if (unpacked.code !== 0 || !isInstalled(storagePath)) return { ok: false, message: `Unpacking netcoredbg failed.\n${unpacked.output}` };
    return { ok: true };
  } finally {
    release();
  }
}
