// Reporter output is separate from test stdout: test names and printed text are
// never used to classify a timeout. Keep completed events if a wall deadline kills
// the process before the reporter finishes.
function timeout(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    seen.add(error);
    if (error.code === 'ERR_TEST_FAILURE' && error.failureType === 'testTimeoutFailure') return true;
    if (error.code !== 'ERR_TEST_FAILURE') return false;
    error = error.cause;
  }
  return false;
}

export default async function* timeoutReporter(events) {
  for await (const event of events) {
    if (event.type !== 'test:fail' && event.type !== 'test:pass') continue;
    const error = event.data.details?.error;
    yield `${JSON.stringify({
      nesting: event.data.nesting,
      failed: event.type === 'test:fail',
      timeout: timeout(error),
      failureType: error?.code === 'ERR_TEST_FAILURE' ? error.failureType : undefined,
    })}\n`;
  }
  yield '{"complete":true}\n';
}

export function classifyReport(text) {
  const events = [];
  let complete = false;
  let invalid = false;
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      if (event.complete === true) complete = true;
      else if (Number.isInteger(event.nesting) && typeof event.failed === 'boolean' && typeof event.timeout === 'boolean') events.push(event);
      else invalid = true;
    } catch { invalid = true; }
  }
  let timedOut = false;
  let ordinaryFailure = invalid;
  // Node emits completed descendants before their parent. Include passes so an
  // unrelated later timeout cannot adopt a cancelled child of a passing parent.
  const ancestors = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    while (ancestors.length && ancestors.at(-1).nesting >= event.nesting) ancestors.pop();
    if (event.failed) {
      if (event.timeout) timedOut = true;
      else if (event.failureType === 'cancelledByParent') {
        if (!ancestors.some(parent => parent.timeout)) ordinaryFailure = true;
      } else if (event.failureType !== 'subtestsFailed') ordinaryFailure = true;
    }
    ancestors.push(event);
  }
  return { timedOut, ordinaryFailure, complete };
}
