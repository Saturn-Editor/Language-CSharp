/**
 * The .NET diagnostic port (IPC) in "connect" mode: a runtime started with
 * DOTNET_DiagnosticPorts=<address>,connect,nosuspend connects to us at startup and advertises its PID, which
 * is how the debug proxy learns what to attach to. (Suspending the runtime here doesn't help: managed code
 * runs before netcoredbg finishes attaching, so the startup hook in server/hook does the waiting.)
 * Protocol: https://github.com/dotnet/diagnostics/blob/main/documentation/design-docs/ipc-protocol.md
 */
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ADVERTISE_MAGIC = 'ADVR_V1\0';
const ADVERTISE_SIZE = 8 + 16 + 8 + 2; // magic, runtime instance GUID, PID (u64), reserved

/**
 * Listens for one runtime. `env` goes into the program's environment; `pid` resolves when the runtime
 * connects; `close()` stops listening.
 */
export async function listenForRuntime({ timeoutMs = 60_000 } = {}) {
  const name = `saturn-csharp-${process.pid}-${randomUUID().slice(0, 8)}`;
  // On Windows the runtime takes a bare pipe name; elsewhere a Unix socket path.
  const address = process.platform === 'win32' ? name : join(tmpdir(), `${name}.sock`);
  const listenPath = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : address;

  let socket = null;
  let advertised = false;
  let resolvePid;
  let rejectPid;
  const pid = new Promise((resolve, reject) => {
    resolvePid = resolve;
    rejectPid = reject;
  });
  const timer = setTimeout(() => rejectPid(new Error('The program did not start in the terminal.')), timeoutMs);

  const server = createServer((conn) => {
    // The runtime reconnects after each session ends; only the first connection matters.
    if (socket) return conn.destroy();
    socket = conn;
    let buffer = Buffer.alloc(0);
    conn.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < ADVERTISE_SIZE || advertised) return;
      if (buffer.toString('latin1', 0, 8) !== ADVERTISE_MAGIC) return rejectPid(new Error('Unexpected diagnostic port message.'));
      advertised = true;
      clearTimeout(timer);
      resolvePid(Number(buffer.readBigUInt64LE(24)));
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPath, resolve);
  });

  const close = () => {
    clearTimeout(timer);
    socket?.destroy();
    server.close();
    if (process.platform !== 'win32') rmSync(address, { force: true });
  };
  return {
    env: { DOTNET_DiagnosticPorts: `${address},connect,nosuspend` },
    pid,
    close,
  };
}
