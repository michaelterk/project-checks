const $ = id => document.getElementById(id);
let selected, run, token, view = 'running', busy = false;
const duration = seconds => seconds == null ? '—' : seconds < 60 ? `${Math.floor(seconds)}s`
  : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60 % 60)}m`;
const groups = { running: ['running', 'validating'], queued: ['queued', 'scanning'],
  completed: ['passed', 'cached', 'failed', 'timed-out', 'cancelled', 'interrupted'], failed: ['failed', 'timed-out'] };
const label = state => state === 'timed-out' ? 'Timed out' : state[0].toUpperCase() + state.slice(1);

async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

function renderFiles() {
  if (!run) return;
  const query = $('search').value.toLowerCase();
  const files = run.files.filter(file => groups[view].includes(file.state)
    && `${file.suite} ${file.file}`.toLowerCase().includes(query));
  if (view === 'queued') files.sort((a, b) => run.suites.indexOf(a.suite) - run.suites.indexOf(b.suite) || a.order - b.order);
  else if (view === 'completed') files.sort((a, b) => b.endedAt - a.endedAt);
  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const row = $('file-row').content.cloneNode(true);
    const cells = row.querySelectorAll('td');
    const seconds = file.state === 'running' ? (Date.now() - file.startedAt) / 1000 : file.seconds;
    [file.file, file.suite, label(file.state), duration(seconds)].forEach((text, index) => { cells[index].textContent = text; });
    cells[2].dataset.status = groups.failed.includes(file.state) ? 'failed' : file.state;
    fragment.append(row);
  }
  $('files').replaceChildren(fragment);
  $('empty').hidden = files.length > 0;
  $('empty').textContent = query ? 'No matching test files.' : `No ${view} test files.`;
  $('list-note').textContent = view === 'queued'
    ? 'Queue order follows the scheduler. Dependencies, worker limits and retries can change what starts next.'
    : view === 'running' ? 'Validating files have finished executing and are checking their evidence.'
      : view === 'completed' ? 'Most recently completed first. Cached files reuse verified passing evidence.' : 'Failed and timed-out test files in this run.';
  for (const button of $('views').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
    button.querySelector('span').textContent = run.files.filter(file => groups[button.dataset.view].includes(file.state)).length;
  }
}

function renderRun() {
  const counts = run.counts;
  $('run-title').textContent = run.target;
  $('run-status').textContent = label(run.status);
  $('run-status').dataset.status = run.status;
  $('progress-label').textContent = counts.total === null ? 'Discovering test files…'
    : `${counts.finished} of ${counts.total} test files finished · ${counts.failed + counts['timed-out']} failed${counts.excluded ? ` · ${counts.excluded} excluded as obsolete` : ''}`;
  $('progress').max = Math.max(1, counts.total ?? 1);
  if (counts.total === null) $('progress').removeAttribute('value');
  else $('progress').value = counts.finished;
  const resource = run.resources;
  $('cpu').textContent = Number.isFinite(resource?.cpuPercent) ? `${resource.cpuPercent.toFixed(0)}%` : '—';
  $('cpu-pressure').textContent = Number.isFinite(resource?.cpuPressure) ? `${(resource.cpuPressure * 100).toFixed(0)}%` : '—';
  $('workers').textContent = resource?.workers ? `${resource.workers.active} / ${resource.workers.limit}` : '—';
  $('workers').title = resource?.workers ? `Configured capacity: ${resource.workers.capacity}` : '';
  $('cached').textContent = counts.cached;
  $('elapsed').textContent = duration(run.elapsedSeconds);
  $('eta').textContent = run.status !== 'running' ? 'Finished' : run.etaSeconds === null ? 'Estimating…' : `~${duration(run.etaSeconds)}`;
  $('timing-note').textContent = run.status !== 'running' ? 'Final resource sample shown.'
    : run.etaSeconds === null ? 'ETA appears when duration history or completed files provide an estimate. Final validation may add time.'
      : `Estimated test completion ${new Date(Date.now() + run.etaSeconds * 1000).toLocaleTimeString()}. Final validation may add time.`;
  $('run-error').hidden = !run.error;
  $('run-error').textContent = run.error ?? '';
  const hasFailures = run.files.some(file => groups.failed.includes(file.state));
  $('discard-form').hidden = run.status !== 'failed' && !(run.status === 'running' && hasFailures);
  $('exclude-current-label').hidden = run.status !== 'running';
  $('discard-form').querySelector('button').disabled = run.status === 'running' && !$('exclude-current').checked;
  $('discard-note').textContent = run.status === 'running'
    ? 'Select this run to exclude its failed files when results are finalized. Other checks and validation still apply.'
    : 'Removes this failed run and its manifest. Test source files are kept.';
  $('exclude-tests').disabled = !hasFailures;
  $('command-section').hidden = !run.commands.length;
  $('commands').replaceChildren(...run.commands.map(command => {
    const item = document.createElement('li');
    item.textContent = `${command.suite} · ${label(command.state)}`;
    item.dataset.status = command.state;
    return item;
  }));
  renderFiles();
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const data = await api('/api/runs');
    token = data.token;
    $('project').textContent = data.root;
    if (!data.runs.some(item => item.id === selected)) selected = data.runs[0]?.id;
    const fragment = document.createDocumentFragment();
    for (const item of data.runs) {
      const row = $('run-row').content.cloneNode(true);
      const button = row.querySelector('button');
      button.dataset.id = item.id;
      button.setAttribute('aria-current', String(item.id === selected));
      row.querySelector('.history-target').textContent = item.target;
      row.querySelector('time').textContent = new Date(item.startedAt).toLocaleString();
      row.querySelector('time').dateTime = new Date(item.startedAt).toISOString();
      row.querySelector('.history-status').textContent = label(item.status);
      row.querySelector('.history-status').dataset.status = item.status;
      fragment.append(row);
    }
    $('runs').replaceChildren(fragment);
    if (selected) { run = await api(`/api/runs/${selected}`); renderRun(); }
    else {
      run = null;
      $('run-title').textContent = 'No saved runs';
      $('run-status').textContent = '';
      $('progress-label').textContent = 'Start checks with --dashboard to see their progress here.';
      $('discard-form').hidden = true;
      $('files').replaceChildren();
      $('command-section').hidden = true;
      $('run-error').hidden = true;
      $('progress').value = 0;
      for (const id of ['cpu', 'workers', 'cached', 'elapsed', 'eta']) $(id).textContent = '—';
      for (const count of $('views').querySelectorAll('span')) count.textContent = '0';
      $('timing-note').textContent = '';
      $('list-note').textContent = '';
      $('empty').hidden = false;
      $('empty').textContent = 'No test files to display.';
    }
    const stale = run?.status === 'running' && Date.now() - run.updatedAt > 10000;
    $('connection').textContent = stale ? 'Runner updates stopped · last state shown' : 'Connected · updates every second';
  } catch (error) {
    $('connection').textContent = `Disconnected · ${error.message}. Retrying…`;
  } finally { busy = false; }
}

$('views').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button) { view = button.dataset.view; renderFiles(); }
});
$('search').addEventListener('input', renderFiles);
$('runs').addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button || busy) return;
  selected = button.dataset.id;
  $('exclude-tests').checked = false;
  $('exclude-current').checked = false;
  void refresh();
});
$('exclude-current').addEventListener('change', () => { if (run) renderRun(); });
$('discard-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !selected) return;
  busy = true;
  const button = event.submitter;
  button.disabled = true;
  try {
    const excludeTests = $('exclude-tests').checked && !$('exclude-tests').disabled;
    const excludeCurrent = run.status === 'running' && $('exclude-current').checked;
    await api(`/api/runs/${selected}/discard`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token }, body: JSON.stringify({ excludeTests, excludeCurrent }) });
    $('message').textContent = excludeCurrent
      ? `Exclusion requested for this run's failed files.${excludeTests ? ' They will also be excluded from future runs.' : ''}`
      : excludeTests ? 'Run discarded. Its failed test files will be excluded from future runs.' : 'Run discarded. Its test files remain available for future runs.';
    if (!excludeCurrent) selected = undefined;
    $('exclude-tests').checked = false;
    $('exclude-current').checked = false;
  } catch (error) { $('message').textContent = error.message; }
  finally { button.disabled = false; busy = false; void refresh(); }
});
void refresh();
setInterval(() => { void refresh(); }, 1000);
