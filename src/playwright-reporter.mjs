import { appendFileSync } from 'node:fs';

// Native reporter events are separate from test output and persist before a wall
// deadline can stop Playwright. Reporter callbacks must not lose a write error:
// Playwright swallows callback exceptions, so never certify completion afterward.
export default class PlaywrightReporter {
  failed = false;
  printsToStdio() { return false; }
  record(event) {
    try { appendFileSync(process.env.PROJECT_CHECKS_PLAYWRIGHT_REPORT, `${JSON.stringify(event)}\n`, { mode: 0o600 }); }
    catch { this.failed = true; }
  }
  onTestEnd(test, result) {
    this.record({ type: 'test', status: result.status, expectedStatus: test.expectedStatus, errors: result.errors.length });
  }
  onError() { this.record({ type: 'error' }); }
  onEnd(result) {
    if (!this.failed) this.record({ type: 'end', status: result.status });
  }
}

export function classifyPlaywrightReport(text, { deadlineExpired = false } = {}) {
  let timedOut = false;
  let ordinaryFailure = false;
  let complete = false;
  const statuses = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];
  for (const line of text.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { ordinaryFailure = true; continue; }
    if (event?.type === 'test' && statuses.includes(event.status) && statuses.includes(event.expectedStatus) && Number.isInteger(event.errors) && event.errors >= 0) {
      if (event.status === 'timedOut') {
        timedOut = true;
        // Playwright exposes no structured type for subsequent errors. Retain
        // them rather than letting a passing retry hide a teardown/assertion.
        if (event.errors > 1) ordinaryFailure = true;
      } else if (event.status === 'interrupted') {
        // Interruption does not identify the cause of any accompanying error.
        // Even one error may be a teardown assertion after our wall deadline.
        if (!deadlineExpired || event.errors) ordinaryFailure = true;
      } else if ((event.status !== 'skipped' && event.status !== event.expectedStatus) || (event.status !== 'failed' && event.errors)) ordinaryFailure = true;
    } else if (event?.type === 'end' && ['passed', 'failed', 'timedout', 'interrupted'].includes(event.status)) {
      complete = true;
      if (event.status === 'timedout') timedOut = true;
      if ((event.status === 'interrupted' && !deadlineExpired) || (event.status === 'failed' && !timedOut)) ordinaryFailure = true;
    } else ordinaryFailure = true;
  }
  return { timedOut, ordinaryFailure, complete };
}
