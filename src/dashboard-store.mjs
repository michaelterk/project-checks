import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDashboardState, failedFile } from './dashboard-state.mjs';
import { atomicJson, excludeTest, readJsonBounded } from './test-exclusions.mjs';
import { inside } from './util.mjs';
import { controlPath, createRunControl, updateControl } from './dashboard-control.mjs';

const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export const dashboardDirectory = root => join(resolve(root), '.test-cache/project-checks/dashboard');

export function runPath(directory, id) {
  if (!validId(id)) throw new Error('Invalid run ID');
  return join(directory, 'runs', `${id}.json`);
}

export async function readRun(directory, id) {
  const run = await readJsonBounded(runPath(directory, id));
  if (run.version !== 1 || run.id !== id || !Array.isArray(run.files) || !run.counts) throw new Error('Invalid run manifest');
  return run;
}

export async function listRuns(directory) {
  let names;
  try { names = await readdir(join(directory, 'runs')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const runs = [];
  for (const name of names) {
    if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
    try {
      const { files, ...run } = await readRun(directory, name.slice(0, -5));
      runs.push({ ...run, failedFiles: files.filter(failedFile).length });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export async function discardRun(directory, root, id, exclude = false, current = false) {
  const run = await readRun(directory, id);
  const files = run.files.filter(failedFile);
  async function excludeFuture() {
    if (!files.length) throw new Error('This run has no failed test files to exclude');
    for (const file of files) {
      if (typeof file.root !== 'string' || !inside(resolve(root), resolve(file.root))) throw new Error('Test root is outside this project');
    }
    for (const file of files) await excludeTest(file.root, file.file);
  }
  if (current) {
    if (run.status !== 'running' || run.endedAt !== null) throw new Error('This run has finished; its exit result cannot be changed');
    if (!files.length) throw new Error('This run has no failed test files to exclude');
    await updateControl(directory, id, async value => {
      if (!value.open) throw new Error('This run is finishing; current-run exclusions are closed');
      if (exclude) await excludeFuture();
      for (const { suite, file } of files) if (!value.files.some(item => item.suite === suite && item.file === file)) value.files.push({ suite, file });
    });
    return;
  }
  if (run.status !== 'failed' || run.endedAt === null) throw new Error('Only a completed failed run can be discarded');
  if (exclude) await excludeFuture();
  // Terminal manifests are immutable; a live writer can never recreate this file.
  await rm(runPath(directory, id), { force: true });
  await rm(controlPath(directory, id), { force: true });
}

export async function createDashboardRecorder(options) {
  const state = createDashboardState(options);
  const directory = dashboardDirectory(options.root);
  await mkdir(join(directory, 'runs'), { recursive: true, mode: 0o700 });
  const path = runPath(directory, state.snapshot().id);
  const failureExclusions = await createRunControl(directory, state.snapshot().id);
  let pending = Promise.resolve(), stopped = false, failure, writing = false, closing;
  const flush = () => {
    writing = true;
    const snapshot = state.snapshot();
    pending = pending.then(() => atomicJson(path, snapshot)).catch(error => { failure ??= error; }).finally(() => { writing = false; });
    return pending;
  };
  await flush();
  if (failure) throw failure;
  const timer = setInterval(() => { if (!stopped && !writing) void flush(); }, 1000);
  timer.unref();
  return {
    id: state.snapshot().id,
    failureExclusions,
    flush: () => stopped ? pending : flush(),
    event: value => { if (!stopped) state.event(value); },
    close(exitCode) {
      closing ??= (async () => {
        stopped = true;
        clearInterval(timer);
        await failureExclusions.close();
        state.finish(exitCode);
        await pending;
        await flush();
        if (failure) throw failure;
      })();
      return closing;
    },
  };
}
