import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeNodeRuntime } from '../backend/lib/runtime-programs.mjs';

// Isolated from install preparation. The body operation owns this whole child
// lifetime: settle only on close, never on the first IPC result.
export function analysisInChild(input, { runtime = null, timeoutMs = 180000,
  entry = fileURLToPath(new URL('./worker.mjs', import.meta.url)) } = {}) {
  const selected = runtime ?? nativeNodeRuntime();
  return new Promise((resolve, reject) => {
    let child;
    try { child = fork(entry, [], { execPath: selected.command, env: selected.env,
      execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); }
    catch (error) { reject(error); return; }
    let value, seen = false, failure, stderr = '', timedOut = false, killer;
    const terminate = () => {
      if (killer || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) killer = new Promise(done => {
        const kill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        kill.once('close', done); kill.once('error', () => { child.kill(); done(); });
      });
      else child.kill('SIGTERM');
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.on('message', message => {
      if (Object.hasOwn(message ?? {}, 'value')) { seen = true; value = message.value; }
      if (message?.error) failure = Object.assign(new Error(message.error.message), { code: message.error.code });
    });
    child.once('close', async (code, signal) => {
      clearTimeout(timer); await killer;
      if (timedOut || code !== 0 || signal || failure || !seen) {
        reject(Object.assign(new Error(timedOut ? 'Analysis process timed out; no successful result' : failure?.message ?? 'Analysis worker exited without a successful result'),
          { code: timedOut ? 'FH_ANALYSIS_TIMEOUT' : failure?.code ?? 'FH_ANALYSIS_PROCESS_FAILED', exitCode: code, signal, stderr }));
      } else resolve(value);
    });
    try { child.send(input, error => { if (error) { failure = error; terminate(); } }); }
    catch (error) { failure = error; terminate(); }
  });
}
