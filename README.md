# project-checks

Run a configured command for each test file, with CPU/RAM-based concurrency and
a cache of successful tests. Import it into a script or use the CLI in any project.
The package uses Node 24+, has no npm dependencies or build step, and is MIT licensed.
Commands can run Node, Python, or another installed test framework.

## Install

Install directly from GitHub:

```sh
npm install --save-dev github:michaelterk/project-checks#COMMIT
```

Replace `COMMIT` with the reviewed commit SHA to pin the installed implementation.

The package has not been published to npm. You can also create an archive here
and install that archive in another project:

```sh
# In this repository
npm pack

# In your project (adjust the path)
npm install --save-dev /path/to/project-checks/project-checks-0.1.3.tgz
```

After a maintainer publishes it under this name, installation will be
`npm install --save-dev project-checks`.

## Import

```js
import { runTests } from 'project-checks';

const result = await runTests({
  testDirectory: 'tests',
  pattern: '**/*.test.mjs',
  resources: { maxWorkers: 4 },
});

process.exitCode = result.exitCode;
```

By default, each file runs with the current Node executable using
`--test --test-concurrency=1`. Commands stream their output. Tests run in the
project root, which defaults to the working directory. A CommonJS script can use
`const { runTests } = require('project-checks')` on the supported Node runtime.
TypeScript declarations are included.

## CLI

Create `project-checks.config.mjs` in your project:

```js
import { defineConfig } from 'project-checks';

export default defineConfig({
  testDirectory: 'tests',
  pattern: '**/*.test.mjs',
  resources: { maxWorkers: 4, memoryMiBPerWorker: 512 },
});
```

Then add a script to your project's `package.json`:

```json
{
  "scripts": {
    "test": "project-checks"
  }
}
```

```sh
npm test
npx project-checks --workers 2
npx project-checks --no-cache
npx project-checks --config config/checks.json
npx project-checks resources
```

The CLI searches the working directory for `project-checks.config.mjs`, `.js`,
then `.json`. Without a config, it discovers `test/**/*.test.{js,mjs,cjs}`.
Paths in a loaded config resolve beside that file; a relative `root` overrides
that location. An explicitly requested missing or invalid config fails.
Exit codes are zero for success, a test's nonzero status for failure, 1 for changed
inputs, 2 for configuration/runtime errors, and 130 for cancellation.

## Other test frameworks

Use an argument array containing `{file}`. The runner replaces that placeholder
with a path relative to the project root and starts the executable directly.
Spaces and shell metacharacters in filenames remain literal arguments.

```js
import { execFileSync } from 'node:child_process';
import { defineConfig } from 'project-checks';

export default defineConfig({
  testDirectory: 'tests',
  pattern: '**/test_*.py',
  command: ['python3', '-m', 'pytest', '{file}'],
  fingerprint: () => execFileSync('python3', ['--version'], {
    encoding: 'utf8',
  }).trim(),
});
```

Use the interpreter and dependencies already installed in the project. The
runner does not install them or pin Python. The runnable
[Python example](examples/python/project-checks.config.mjs) uses standard-library
`unittest`; the [Node example](examples/node/project-checks.config.mjs) uses `node:test`.
Executables must be directly spawnable; shell built-ins and Windows `.cmd`
wrappers need an explicit interpreter command. Each file must be independently
runnable. Choose one worker when tests share mutable state or a fixed port.

## Cache behavior and inputs

Only zero-exit tests with unchanged inputs receive passing evidence. Evidence
is written atomically per file, so completed passes survive a later test failure
or interruption. A failed test reruns on the next invocation. Corrupt evidence
also reruns. Input snapshots are checked after successful commands and again
before reporting suite success, including when all tests were cached.

The default `inputs: ['.']` fingerprints the full project tree: hidden files,
tests, configuration, installed dependencies and symlink targets. `.git`,
`.test-cache` and Python `__pycache__` directories are excluded. Symlink cycles
retain their targets without being traversed repeatedly. The configured cache
directory is always excluded. The input content, permission bits, command,
effective environment, Node runtime/platform and package implementation all
contribute to evidence identity. Cache files contain hashes, never environment
values. Defaults favor complete input tracking, which can be expensive for large
dependency trees.

For per-file reuse after editing a test, explicitly select shared source,
dependencies, configuration and fixtures:

```js
export default {
  testDirectory: 'tests',
  inputs: [
    'src',
    'package.json',
    'package-lock.json',
    'node_modules',
    'tests/helpers',
    'tests/fixtures',
  ],
};
```

Each discovered test file is always fingerprinted separately. Everything in
`inputs` invalidates all units when it changes. Include tests imported/read by
other tests among the shared inputs. Newly added tests run; removed tests leave
the selection. With the full-project default, editing a test invalidates every
test because sibling tests can be shared fixtures in any language.

Paths and globs are relative to `root`. Literal directories recursively include
hidden files; glob patterns follow Node's
[glob behavior](https://nodejs.org/api/fs.html#fspromisesglobpattern-options).
Missing input paths contribute no files and are detected when created. `ignore`
replaces the default exclusions and applies to discovery and shared inputs.
Exclude generated outputs to keep tests from changing their own inputs:

```js
export default {
  ignore: [
    '**/.git', '**/.git/**',
    '**/.test-cache', '**/.test-cache/**',
    '**/__pycache__', '**/__pycache__/**',
    'coverage', 'coverage/**',
  ],
};
```

Inputs outside the project (global interpreters, external dependency environments,
browser binaries, services) need a `fingerprint` callback that returns their
current identity, or `cache: false`. The callback is evaluated with each snapshot.
Passing-test caching assumes deterministic tests against the selected inputs.
`cache: false` and `--no-cache` execute all tests without reading or writing evidence.
They still check that inputs stay unchanged during execution.

Display variables, shell bookkeeping and npm's execution metadata are excluded
from environment identity. Other variables invalidate evidence by default.
`ignoreEnv` can name additional scheduling/output variables; use it only for
values that do not affect test meaning. Environment overrides supplied through
`env` are included in the fingerprint; setting a value to `undefined` removes it.
`NODE_TEST_CONTEXT` is removed from child environments so imported use also works
inside Node's own test runner.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `root` | Working directory | Project root; loaded configs resolve beside their file |
| `testDirectory` | `test` | One folder containing tests |
| `pattern` | `**/*.test.{js,mjs,cjs}` | A glob or array of globs relative to the test folder |
| `command` | Current Node, `--test --test-concurrency=1 {file}` | Executable and argument array |
| `inputs` | `['.']` | Shared input paths/globs relative to root |
| `ignore` | `.git`, `.test-cache`, `__pycache__` trees | Replaces default root-relative exclusions |
| `workers` | Automatically tuned CPU/RAM-derived count | Positive integer fixed override |
| `resources` | See below | Resource policy |
| `cache` | `true` | Read/write passing evidence |
| `cacheDirectory` | `.test-cache/project-checks` | Evidence storage, relative to root or absolute |
| `suite` | `tests` | Cache namespace |
| `env` | Inherit environment | String overrides; undefined removes a variable |
| `ignoreEnv` | `[]` | Additional environment names excluded from evidence |
| `fingerprint` | None | Sync/async callback returning an extra identity string |
| `signal` | None | AbortSignal for cancellation |
| `logger` | `console` | Object with `log`/`error`, or `false` |
| `stdio` | `inherit` | Child output: `inherit` or `ignore` |

Unknown options, invalid limits, duplicate units, escaping/symlinked test files,
and empty test selections fail explicitly.

The resource policy uses 100% of detected available CPUs, zero reserves,
1 CPU and 256 MiB per worker, and `divisor: 1`. Set `cpuPercent`, `reserveCpus`,
`reserveMemoryMiB`, `cpusPerWorker`, `memoryMiBPerWorker`, `maxWorkers` and
`divisor` as needed. `cpusPerWorker` is the estimate for the static
`selectConcurrency` API; automatic runs replace it with a run-local weight. The CPU and
memory budgets each constrain concurrency. `divisor` shares the original host
budget for nested orchestration; the caller supplies that share. Explicit
`workers` retains fixed concurrency and overrides automatic admission.

Without explicit `workers`, fresh commands start at half the available CPU budget
(rounded down, minimum one), clamped by live free RAM, the reserve and hard caps.
They automatically adjust the effective `cpusPerWorker`. Three consecutive one-second
samples of spare CPU and RAM permit one additional worker; sustained CPU or
memory pressure reduces new admissions.
Saturation alone holds the count. `maxWorkers` and configured RAM reservations
remain bounds, including a cap of one for suites requiring serial execution.

The total RAM budget limits reservations; a live headroom check pauses admission
below `reserveMemoryMiB` plus one worker's RAM estimate, or during memory pressure.
Active commands finish normally. If admission stays blocked with no active
worker for 30 seconds, the run fails rather than forcing
one through. This is conservative admission, not protection against every memory
spike. CPU feedback uses host usage and Linux pressure data where available;
missing CPU measurements retain the conservative startup count. No process-tree profiling,
calibration runs or saved tuning profiles are used. Each invocation learns anew.
Cached passes bypass admission. A short summary reports peak fresh workers,
sampled CPU, minimum available RAM and the final effective CPU weight.

## API results and adapters

`runTests(config)` returns:

```js
{
  exitCode: 0,
  total: 3,
  passed: 1,       // Fresh commands that exited zero
  failed: 0,
  cached: 2,
  workers: 2,
  inputsChanged: false,
  results: [ /* { id, exitCode, cached }, in discovery order */ ],
}
```

Check `exitCode` for suite success; individual zero-exit commands can still have
`inputsChanged: true`. Nonzero commands do not stop the queue, and all active
commands drain before the promise resolves. Runtime errors reject after active
work drains. Cancellation stops admission and terminates direct child processes,
with a forced kill after two seconds if necessary. Commands that spawn background
processes are responsible for cleaning up those descendants.

For integrations that supply their own discovery and fingerprints, use
`runCachedUnits`:

```js
import { runCachedUnits } from 'project-checks';

const result = await runCachedUnits({
  cacheDirectory: '/project/.test-cache/custom',
  suite: 'custom',
  workers: 2,
  units: [{ id: 'integration', identity: 'adapter-v1' }],
  snapshot: async () => ({
    common: await hashSharedInputs(),
    units: { integration: await hashIntegrationInputs() },
  }),
  execute: async unit => runIntegration(unit), // Return an integer exit code
});
```

Snapshots must include exactly the current unit IDs. Each unit needs a command
array or an explicit identity for its execution behavior. Include the project
identity and every shared dependency in `common`. Supply `environment` when an
adapter uses a child environment different from `process.env`. Adapters own their
discovery/fingerprint completeness and cancellation of their own commands.

The other exports are `defineConfig`, `loadConfig`, `runCommand`,
`environmentIdentity`, `detectResources` and `selectConcurrency`.

## Development

```sh
npm test
npm run resources
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for release checks.
