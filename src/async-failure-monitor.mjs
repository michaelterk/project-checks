import { appendFileSync, readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';

// Node can reduce errors raised after a test finishes to informational reporter
// diagnostics. Observe the actual process events instead of guessing from text.
// --import also reaches fork fixtures: parent identity scopes this observer to
// the owned launcher and its native test workers, never their nested fixtures.
const params = new URL(import.meta.url).searchParams;
const report = params.get('report');
const ownerFile = `${report}.owner`;
// A fast child can reach this preload before the coordinator's atomic rename.
// Block only this startup handshake, before user preloads, with a bounded wait.
const until = performance.now() + 1000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let launcher;
while (true) {
  try { launcher = Number(readFileSync(ownerFile, 'utf8')); break; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (performance.now() >= until) throw new Error('Timed out waiting for timeout observer ownership publication');
    Atomics.wait(sleeper, 0, 0, 5);
  }
}
if (!Number.isSafeInteger(launcher) || launcher <= 0) throw new Error('Invalid timeout observer process ownership');
const owned = isMainThread && (process.pid === launcher ||
  (process.ppid === launcher && process.env.NODE_TEST_CONTEXT === 'child-v8'));

if (owned) {
  const originalEmit = process.emit;
  process.emit = function emit(event, ...args) {
    const result = Reflect.apply(originalEmit, this, [event, ...args]);
    // Do not register a rejection listener: Node uses emit's original boolean
    // result to choose throw/warn/none behavior. Observe only fatal defaults or
    // handlers that mark failure (including Node's diagnostic-only late errors).
    const fatal = event === 'uncaughtExceptionMonitor' && this.listenerCount('uncaughtException') === 0 && !this.hasUncaughtExceptionCaptureCallback();
    const failed = (event === 'uncaughtException' || event === 'unhandledRejection') && Number(this.exitCode) > 0;
    if (fatal || failed) appendFileSync(report, '1');
    return result;
  };
}
