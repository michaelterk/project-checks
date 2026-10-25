// Only callers ready before collection begins may share filesystem observations.
// Each batch owns its preparation; slow units never hold up independent units.
export function batchValidationSnapshots(prepare) {
  let pending;
  return id => new Promise((resolve, reject) => {
    if (!pending) {
      pending = [];
      setImmediate(async () => {
        const requests = pending;
        pending = undefined;
        try {
          const read = await prepare();
          for (const request of requests) {
            Promise.resolve().then(() => read(request.id)).then(request.resolve, request.reject);
          }
        } catch (error) { for (const request of requests) request.reject(error); }
      });
    }
    pending.push({ id, resolve, reject });
  });
}
