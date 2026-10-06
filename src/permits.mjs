// Run-local, abortable permits. Each acquisition returns its own release owner.
export function createPermits(limit, signal) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (!signal.aborted && active < limit && waiting.length) {
      const { resolve } = waiting.shift();
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  }
  const abort = () => waiting.splice(0).forEach(({ reject }) => reject(signal.reason));
  signal.addEventListener('abort', abort, { once: true });
  return {
    acquire() {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); drain(); });
    },
    close() { signal.removeEventListener('abort', abort); },
  };
}
