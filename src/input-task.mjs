import { text } from './util.mjs';

export const inputProcess = Symbol('project-checks.input-process');
const runtimeFields = ['root', 'suite', 'testDirectory', 'pattern', 'inputs', 'ignore',
  'directoryIgnore', 'cacheDirectory', 'excludeTestsFromInputs'];
const configurations = new Map(), digests = new Map();
const signal = new AbortController().signal; // Parent cancellation stops the worker's entire process group.

export function createProcessSnapshot(config, context, selectTests) {
  const descriptor = config[inputProcess];
  const prepare = async initialInventory => {
    const inventory = initialInventory ?? await context.discoverInventory(config);
    const files = selectTests(config, inventory);
    if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
    const definition = { fixture: descriptor.fixture, base: descriptor.base, inventory,
      runtime: structuredClone({ ...Object.fromEntries(runtimeFields.map(key => [key, config[key]])), files }) };
    const value = { common: '', units: {} };
    let common;
    const unit = async id => {
      config.signal?.throwIfAborted();
      // Fixture-owned runtime paths stay with their original owner.
      const declared = config.testFixtureInputs ? await config.testFixtureInputs(id) : [];
      if (!Array.isArray(declared)) throw new TypeError('testFixtureInputs must return an array of literal paths');
      const fixtures = declared.map(path => text(path, 'fixture input path'));
      common ??= Promise.resolve().then(() => context.inputTask(definition, { mode: 'common' }));
      const operation = () => context.inputTask(definition, { mode: 'unit', id, fixtures });
      const task = Promise.resolve().then(() => config.diagnostics
        ? config.diagnostics.span(config.suite, 'process-input-unit', operation, { file: id }) : operation());
      const settled = await Promise.allSettled([common, task]);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const result = settled[1].value;
      if (typeof settled[0].value !== 'string' || typeof result?.value !== 'string' || typeof result.proof !== 'string')
        throw new Error('Invalid process input snapshot response');
      config.signal?.throwIfAborted();
      value.common = settled[0].value;
      value.units[id] = result.value;
      config.diagnostics?.file(config.suite, id, 'dependency-discovery', {
        seconds: result.seconds, inputCount: result.inputCount,
      });
      return result.proof;
    };
    return { files, value, unit };
  };
  const snapshot = async () => {
    const prepared = await prepare();
    const settled = await Promise.allSettled(prepared.files.map(prepared.unit));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return prepared.value;
  };
  snapshot.prepare = prepare;
  snapshot.close = () => context.close();
  return snapshot;
}

// Only explicitly process-safe fixture factories are hydrated here. No setup runs.
export async function runInputTask(definition, task) {
  const key = JSON.stringify([definition.fixture, definition.base]);
  if (!configurations.has(key)) configurations.set(key, (async () => {
    const { default: fixture } = await import(definition.fixture);
    const base = structuredClone(definition.base);
    return { ...base, ...await fixture(base, { signal }) };
  })());
  const hydrated = await configurations.get(key);
  const { createSnapshot, createSnapshotContext } = await import('./inputs.mjs');
  const context = createSnapshotContext({ local: true, digestCache: digests, signal });
  let seconds = 0, inputCount = 0;
  const config = { ...hydrated, ...definition.runtime, select: undefined, signal,
    testFixtureInputs: () => task.fixtures ?? [],
    testInputs: async id => {
      const started = performance.now();
      const result = typeof hydrated.testInputs === 'function' ? await hydrated.testInputs(id)
        : Object.entries(hydrated.testInputs ?? {}).filter(([scope]) => scope === id || (scope.endsWith('/') && id.startsWith(scope))).flatMap(([, values]) => values);
      seconds = (performance.now() - started) / 1000;
      inputCount = result?.length;
      return result;
    },
  };
  try {
    const plan = await createSnapshot(config, context).prepare(definition.inventory,
      task.mode === 'unit' ? { common: '' } : undefined);
    if (task.mode === 'common') return await plan.common();
    const proof = await plan.unit(task.id);
    return { value: plan.value.units[task.id], proof, seconds, inputCount };
  } finally { await context.close(); }
}
