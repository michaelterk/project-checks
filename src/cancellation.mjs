let active;

// Default API calls in this process share one signal owner. Explicit signals
// remain caller-owned; nested default calls keep ownership until all have drained.
export async function withProcessSignal(signal, execute) {
  if (signal !== undefined) return execute(signal);
  if (!active) {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new DOMException('Received SIGINT', 'AbortError'));
    const terminate = () => controller.abort(new DOMException('Received SIGTERM', 'AbortError'));
    active = { controller, interrupt, terminate, references: 0 };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  const owner = active;
  owner.references++;
  try { return await execute(owner.controller.signal); }
  finally {
    if (--owner.references === 0) {
      process.removeListener('SIGINT', owner.interrupt);
      process.removeListener('SIGTERM', owner.terminate);
      active = undefined;
    }
  }
}
