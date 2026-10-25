import { digest, text } from './util.mjs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

export const inputProcess = Symbol('project-checks.input-process');
const runtimeFields = ['root', 'suite', 'testDirectory', 'pattern', 'inputs', 'ignore',
  'directoryIgnore', 'cacheDirectory', 'excludeTestsFromInputs'];
const configurations = new Map(), digests = new Map();
const signal = new AbortController().signal; // Parent cancellation stops the worker's entire process group.

export function createProcessSnapshot(config, context, selectTests, createSnapshot) {
  const descriptor = config[inputProcess];
  const prepare = async initialInventory => {
    const generation = context.inputGeneration?.();
    const inventory = initialInventory ?? await context.discoverInventory(config);
    const files = selectTests(config, inventory);
    if (!files.length) throw new Error(`No test files found in ${config.testDirectory}`);
    let inputData, inputDataHash;
    if (generation !== undefined && descriptor.prepareInputs) {
      config.signal?.throwIfAborted();
      let supplied;
      try { supplied = await descriptor.prepareInputs(structuredClone(descriptor.base), { signal: config.signal, inputGeneration: generation }); }
      finally { config.signal?.throwIfAborted(); }
      let encoded;
      try { encoded = JSON.stringify(supplied); }
      catch (cause) { throw new TypeError('prepareInputs must return plain JSON data', { cause }); }
      if (encoded === undefined) throw new TypeError('prepareInputs must return plain JSON data');
      if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new TypeError('prepareInputs data exceeds 16 MiB');
      inputData = JSON.parse(encoded);
      if (!isDeepStrictEqual(inputData, supplied)) throw new TypeError('prepareInputs must return plain JSON data');
      inputDataHash = digest(encoded);
    }
    const definition = { generation: generation ?? randomUUID(), fixture: descriptor.fixture, base: descriptor.base, inventory,
      ...(inputDataHash ? { inputData, inputDataHash } : {}),
      runtime: structuredClone({ ...Object.fromEntries(runtimeFields.map(key => [key, config[key]])), files }) };
    const value = { common: '', units: {} };
    // Walk shared trees through the invocation's parallel scanner. Only the
    // CPU-heavy projection owns one process slot, rather than the entire tree.
    const commonSnapshot = createSnapshot({ ...config, [inputProcess]: undefined,
      inputProjection: config.inputProjection
        ? entries => context.inputTask(definition, { mode: 'projection', entries }) : undefined,
    }, context);
    let common;
    const getCommon = () => common ??= commonSnapshot.prepare(inventory).then(plan => plan.common());
    const unit = async id => {
      config.signal?.throwIfAborted();
      // Fixture-owned runtime paths stay with their original owner.
      const declared = config.testFixtureInputs ? await config.testFixtureInputs(id) : [];
      if (!Array.isArray(declared)) throw new TypeError('testFixtureInputs must return an array of literal paths');
      const fixtures = declared.map(path => text(path, 'fixture input path'));
      const shared = getCommon();
      const operation = () => context.inputTask(definition, { mode: 'unit', id, fixtures });
      const task = Promise.resolve().then(() => config.diagnostics
        ? config.diagnostics.span(config.suite, 'process-input-unit', operation, { file: id }) : operation());
      const settled = await Promise.allSettled([shared, task]);
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
    return { files, value, unit, common: getCommon };
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
  const key = JSON.stringify([definition.fixture, definition.base, definition.runtime.inputs]);
  let configuration = configurations.get(key);
  if (!configuration || configuration.generation !== definition.generation || configuration.inputDataHash !== definition.inputDataHash) {
    configuration = { generation: definition.generation, inputDataHash: definition.inputDataHash, hydrated: (async () => {
    const { default: fixture } = await import(definition.fixture);
    const base = structuredClone(definition.base);
    return { ...base, ...await fixture(base, { signal, inputGeneration: definition.generation,
      ...(definition.inputDataHash ? { inputData: structuredClone(definition.inputData) } : {}),
      commonInputs: Object.freeze([...definition.runtime.inputs]) }) };
    })() };
    configurations.set(key, configuration);
  }
  const hydrated = await configuration.hydrated;
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
    if (task.mode === 'projection') {
      const value = await hydrated.inputProjection(task.entries, { kind: 'common', signal,
        generation: {}, identify: paths => context.identify(paths.map(path => resolve(path)), { ...config, allowMissing: true }) });
      const encoded = JSON.stringify(value);
      if (encoded === undefined || !isDeepStrictEqual(JSON.parse(encoded), value))
        throw new TypeError('inputProjection must return plain JSON data');
      return value;
    }
    const plan = await createSnapshot(config, context).prepare(definition.inventory,
      { common: '' });
    const proof = await plan.unit(task.id);
    return { value: plan.value.units[task.id], proof, seconds, inputCount };
  } finally { await context.close(); }
}
