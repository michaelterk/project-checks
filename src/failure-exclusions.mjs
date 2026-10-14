// Explicit exclusions remove failed results; they never create passing evidence
// or clear input, coverage, setup, cancellation, or prerequisite failures.
export async function excludeFailures(result, policy, suite, progress) {
  if (!policy || !result.failed) return;
  const excluded = new Set(await policy.files(suite));
  const removed = result.results.filter(file => file.exitCode !== 0 && excluded.has(file.id));
  if (!removed.length) return;
  const ids = new Set(removed.map(file => file.id));
  result.results = result.results.filter(file => !ids.has(file.id));
  result.excludedFiles = [...(result.excludedFiles ?? []), ...ids];
  result.excluded = result.excludedFiles.length;
  result.total = result.results.length;
  result.failed = result.results.filter(file => file.exitCode !== 0).length;
  result.exitCode = result.inputsChanged ? 1 : result.results.find(file => file.exitCode !== 0)?.exitCode ?? 0;
  for (const file of ids) progress && progress.file(suite, file, 'file-excluded');
  return true;
}
