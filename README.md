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
npm install --save-dev /path/to/project-checks/project-checks-0.3.4.tgz
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
npx project-checks --file test/example.test.mjs
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
import { defineConfig } from 'project-checks';

export default defineConfig({
  testDirectory: 'tests',
  pattern: '**/test_*.py',
  command: ['python3', '-m', 'pytest', '{file}'],
});
```

Use the interpreter and dependencies already installed in the project. The
runner does not install them or pin Python. The runnable
[Python example](examples/python/project-checks.config.mjs) uses standard-library
`unittest`; the [Node example](examples/node/project-checks.config.mjs) uses `node:test`.
Executables must be directly spawnable; shell built-ins and Windows `.cmd`
wrappers need an explicit interpreter command. Each file must be independently
runnable. Choose one worker when tests share mutable state or a fixed port.

## Checks and prerequisites

Use a project JSON file to select suites and order builds or other prerequisites:

```json
{
  "checks": {
    "build": { "command": ["npm", "run", "build"] },
    "unit": {
      "config": "project-checks.unit.json",
      "fixture": "tests/check-fixtures.mjs",
      "dependsOn": ["build"]
    }
  },
  "targets": { "default": ["unit"], "complete": ["unit"] }
}
```

`config` names a suite configuration. Optional `fixture` names a module whose
default export receives `(config, { signal })` and returns configuration overrides,
such as runtime inputs, environment or `setup`. Paths resolve beside the project
JSON. A command check may set `cwd` and `env`; a nested owner uses `project` and
an optional `target` instead of `config`.

```js
import { loadChecks, runChecks } from 'project-checks';

const checks = await loadChecks('project-checks.project.json', { target: 'complete' });
process.exitCode = (await runChecks(checks)).exitCode;
```

`loadChecks` expands targets and dependencies without executing checks.
`runChecks` owns shared admission, cancellation and cleanup. It loads and scans
independent suites together before executing checks. Dependent configuration
factories and cache scans wait for successful prerequisites, so generated inputs
exist and reflect the completed build. A failed prerequisite prevents its
dependent from loading configuration, scanning evidence or running fixtures. Duplicate IDs,
unknown dependencies and cycles fail. Final verification rechecks participating
suite inputs and loaded JSON configurations before the invocation succeeds.

The CLI equivalent is:

```sh
project-checks checks --config project-checks.project.json --target complete
```

`loadChecks` also accepts `files`, `filters`, `cache`, `frameworkArgs` and an ID `prefix`. Filters
use complete Node options such as `--test-name-pattern=example`; filtered runs
do not reuse or save complete-file evidence. App fixtures own their isolated
resources; the package invokes their `setup`, `execute` and `close` hooks.
The CLI accepts `--test-name-pattern`, `--test-skip-pattern` and `--test-only`.
Arguments after `--` are Playwright framework actions, such as `--update-snapshots`,
and run without complete-file evidence.

## Coverage

Detected Node and Python test suites collect coverage by default. Every omitted
minimum independently defaults to 80% for lines, branches and functions. Override
metrics and source domains in the suite JSON:

```json
{
  "suite": "server",
  "testDirectory": "tests",
  "coverage": {
    "provider": "v8",
    "include": ["src/**/*.mjs"],
    "exclude": ["**/*.test.mjs"],
    "minimum": { "lines": 92.5, "branches": 85, "functions": 90 }
  }
}
```

`provider` defaults to `v8`; `include` and `exclude` select its source domain.
For Python, use `provider: "python"`, an optional `python` interpreter and
`configFile` pointing to the project's coverage.py configuration. Install
coverage.py in that interpreter's environment; configure Python source domains
in `configFile`. The package adds collection to the ordinary Python test command.
Set `coverage: false` for syntax, browser journeys or other commands that have
no coverage gate.

The package retains raw contributions with passing-file evidence, validates
them on reuse, and aggregates every current suite file before enforcing its
minimums. Fractional minimums are enforced. Partial file selections can retain
contributions but do not pass the full-suite coverage gate; filtered runs do not
contribute coverage. Changing only minimums or V8 domain rules rebuilds the gate
from compatible contributions.
Cached coverage stores project-relative source paths and resolves them against
the current root when reporting. Source content bindings belong to artifact
metadata, separate from validity keys; renamed reporting paths require a new
contribution. Moving an unchanged checkout preserves reusable coverage.

`reportCoverage(config)` returns saved measurements, current minimums and
staleness without running tests. Optional `coverage.report` selects the saved
summary path; the default is inside the suite's package cache. For project JSON:

```sh
project-checks coverage --config project-checks.project.json --target complete
```

## Cache behavior and inputs

`runChecks` scans initially ready suites together, including independent nested
projects, before starting commands, fixture setup or tests. Dependent suites load
configuration and scan only after their prerequisites pass. All passing records
enter one shared queue with up to 16 concurrent reads. Coverage and other retained
artifacts are validated and restored under resource admission before a file is
counted as skippable. A combined summary covers initially ready suites; dependent
suites report their plans as prerequisites finish. The runner schedules files
from these in-memory plans. Missing or corrupt records and incompatible artifacts
rerun. Fixture setup, retries and final input verification retain their existing
checks. Standalone `runTests` and `runCachedUnits` scan their own selected files.

```text
CACHE_SCAN: checks | Scanning initially ready test files | Concurrency: 16
CACHE_SCAN: checks | Will run: 32 | Will skip: 208 | Total: 240 | Duration: 0.12s
```

Only zero-exit tests with unchanged inputs receive passing evidence. Evidence
is written atomically per file, so completed passes survive a later test failure
or interruption. A failed test reruns on the next invocation. Corrupt evidence
also reruns. Input snapshots are checked after successful commands and again
before reporting suite success, including when all tests were cached.

The default `inputs: ['.']` fingerprints the full project tree: hidden files,
tests, configuration, installed dependencies and symlink targets. `.git`,
`.test-cache` and Python `__pycache__` directories are excluded. Symlink cycles
retain their targets without being traversed repeatedly. The configured cache
directory is always excluded. Validity uses only existence and SHA-256 content
hashes. File/directory names, root paths, attributes, commands, environment,
runtime identities and retry settings do not enter the validity key. Directory
presence has no byte content and is represented by existence with a null hash.
Suite and test IDs select the cache record; they are not part of its validity.
Defaults favor complete input tracking, which can be expensive for large trees.

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

For independent tests, map dependency folders to test folders or individual files
in JSON. Folder keys end in `/`; all matching folder and exact-file entries add
dependencies together. `inputs` remains the shared dependency list:

```json
{
  "inputs": [],
  "excludeTestsFromInputs": true,
  "testInputs": {
    "test/": ["src/common", "test/helpers"],
    "test/api/": ["src/api", "node_modules/example-client"],
    "test/api/upload.test.mjs": ["fixtures/uploads"]
  },
  "retryTimeouts": true
}
```

With `excludeTestsFromInputs: true`, folder/glob dependencies exclude every
runnable test in the configured inventory. Each selected test still hashes its
own file. Adding/removing test files within existing folders does not invalidate
siblings. Directory presence, including empty fixture folders, remains an input:
adding/removing directories can invalidate consumers of the containing folder.
Helpers and fixtures remain dependencies. If a test imports another runnable test, extract
the shared code to a helper or explicitly list that runnable file as a literal
dependency; explicit file dependencies still invalidate their consumers.
The option defaults to false to preserve existing sibling-as-fixture behavior.

Use `files: ["test/api/upload.test.mjs"]` or repeatable CLI `--file` to run a
subset while retaining the full configured inventory. Do not narrow `pattern`
for focused runs with independent-test exclusion. Unused `testInputs` entries
do not invalidate selected units; the config file itself is a dependency only
when selected by `inputs`/`testInputs`. Include every imported helper and installed
dependency used by each scope; mappings do not infer imports or package closures.

Paths and globs are relative to `root`. Literal directories recursively include
hidden files; glob patterns follow Node's
[glob behavior](https://nodejs.org/api/fs.html#fspromisesglobpattern-options).
Missing literal input paths contribute existence=false and a null content hash. `ignore`
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

External file inputs (interpreters, dependencies and browser binaries) can be
declared through `testFixtureInputs`; their existence and content are hashed.
When files use different external fixtures, supply programmatic
`testFixtureInputs(id)` instead: return a sync/async array of literal file or
directory paths, root-relative or absolute. The package hashes those paths only
for that selected file, alongside its own file and JSON `testInputs`. For
example, a browser lane can bind Chromium to lifecycle tests and WebKit to page
tests without a Chromium update invalidating WebKit-only files. The callback
receives canonical root-relative IDs on every snapshot, including focused runs.
Fixture code declares paths and any required safety checks; it need not compute
hashes or manage passing evidence. Missing declared paths contribute existence=false; an empty array
declares no extra inputs. This trusted programmatic callback can name external
paths, while JSON inputs remain root-relative. Existing symlink traversal applies;
fixtures that require containment must check their bundle before returning paths.
Explicit fixture declarations ignore ordinary `ignore` rules, so an engine bundle
excluded from a broad SDK input can still be tracked for its actual consumers.
Fixture directories inside or resolving into `cacheDirectory` are rejected.
Load the JSON config and add this fixture callback before calling `runTests`.
For import discovery, `testInputs` also accepts a sync/async `(id) => string[]`
callback. It runs on every snapshot, including focused runs, and returns
root-relative dependency paths/globs. Ordinary exclusions apply to these inputs;
`testFixtureInputs` remains the API for literal external fixtures.

Passing-test caching assumes deterministic tests against the selected inputs.
`cache: false` and `--no-cache` execute all tests without reading or writing evidence.
They still check that inputs stay unchanged during execution.

Environment values configure execution but do not affect content validity.
`env` overrides inherited values; setting a value to `undefined` removes it.
`NODE_TEST_CONTEXT` is removed from child environments so imported use also works
inside Node's own test runner.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `root` | Working directory | Project root; loaded configs resolve beside their file |
| `extends` | None | Inherit a configuration before applying local overrides |
| `testDirectory` | `test` | One folder containing tests |
| `pattern` | `**/*.test.{js,mjs,cjs}` | A glob or array of globs relative to the test folder |
| `files` | All discovered files | Selected root-relative IDs from the full configured inventory |
| `select` | Full inventory | Suite `include`/`exclude` globs, or a predicate |
| `command` | Current Node, `--test --test-concurrency=1 {file}` | Argument array or programmatic `(id) => argv` |
| `engine` | Detect Node/Python commands | Explicit `node`, `playwright` or `command` execution |
| `coverage` | Detected test engine, 80% per metric | Provider, domain and minimums; `false` disables collection |
| `filters` | `[]` | Complete Node test filter options; bypass file evidence and coverage |
| `frameworkArgs` | `[]` | Playwright action arguments; run without file evidence |
| `setup` | None | Programmatic fixture returning optional `execute` and `close` hooks |
| `inputs` | `['.']` | Shared input paths/globs relative to root |
| `testInputs` | `{}` | Dependency mapping or sync/async callback returning relative paths/globs |
| `excludeTestsFromInputs` | `false` | Omit runnable tests from dependency folders/globs; own and explicit file inputs remain |
| `ignore` | `.git`, `.test-cache`, `__pycache__` trees | Replaces default root-relative exclusions |
| `workers` | Automatically tuned CPU/RAM-derived count | Positive integer worker cap |
| `resources` | See below | Resource policy |
| `cache` | `true` | Read/write passing evidence |
| `cacheDirectory` | `.test-cache/project-checks` | Evidence storage, relative to root or absolute |
| `retryTimeouts` | `false` | Retry verified timeouts once after normal work drains |
| `retryTimeoutMs` | `60000` | Node default test timeout on retry; explicit test timeouts still apply |
| `timeoutMs` | None | Wall deadline per command attempt, including retries |
| `suite` | `tests` | Cache namespace |
| `env` | Inherit environment | String overrides; undefined removes a variable |
| `normalizeNpmEnvironment` | `false` | Remove npm launch metadata and use the owning project's executable search path |
| `testFixtureInputs` | None | Programmatic sync/async callback `(id) => string[]` declaring literal fixture input paths |
| `admission` | None | Caller-owned worker pool shared across `runTests` calls |
| `snapshotContext` | None | Caller-owned hashing queue shared across snapshots/suites |
| `diagnostics` | None | Invocation observer returned by `createDiagnostics` |
| `durationHints` | `false` | Learn and reuse source-bound longest-first timings |
| `initialDurations` | `{}` | Initial positive timing estimates by test ID, in seconds |
| `signal` | None | AbortSignal for cancellation |
| `logger` | `console` | Object with `log`/`error`, or `false` |
| `stdio` | `inherit` | Child output: `inherit` or `ignore` |

Unknown options, invalid limits, duplicate units, escaping/symlinked test files,
and empty test selections fail explicitly.

The resource policy uses 100% of detected available CPUs, zero reserves,
1 CPU and 256 MiB per worker, and `divisor: 1`. Set `cpuPercent`, `reserveCpus`,
`cpuQuotaPercent`, `reserveMemoryMiB`, `cpusPerWorker`, `memoryMiBPerWorker`, `maxWorkers` and
`divisor` as needed. `cpusPerWorker` is the estimate for the static
`selectConcurrency` API; automatic runs replace it with a run-local weight. The CPU and
memory budgets each constrain concurrency. `divisor` shares the original host
budget for nested orchestration; the caller supplies that share. With a resource
policy, explicit `workers` sets an upper bound; CPU and memory admission still apply.
Programmatic callers can pass one `Admission` instance to several
`runCachedUnits` calls. It bounds their combined active commands and retains
one learned CPU weight; each suite keeps its own snapshot and passing evidence.
The caller closes that pool after all calls settle. Explicit `workers` on
`Admission` bounds artifact restoration and execution, within RAM, unit and
worker caps. Lightweight passing-record reads use the separate shared limit of 16.
Input fingerprinting bounds filesystem work at eight operations within one
invocation, with fresh metadata on every snapshot. Content digests and path-only
exclusion decisions are reused; listings and snapshots are not.

Admission targets at most `resources.cpuQuotaPercent` of detected host CPU capacity (default 90%), reserving roughly
10% by default for other work even when `cpuPercent` is higher. Automatic runs start at half
this budget (rounded down, minimum one), clamped by live free RAM and hard caps.
Explicit worker caps set the initial count and still respond to CPU feedback.
They automatically adjust the effective `cpusPerWorker`. Three consecutive one-second
samples of spare CPU and RAM permit one additional worker only when its estimated
CPU cost fits the budget. The first over-budget sample reduces future admissions;
sustained CPU or memory pressure also reduces them. Usage at the ceiling holds
the count. This is sampled admission control, not an OS CPU quota: running
commands finish normally, a single command can exceed the target, and short
bursts or unrelated host processes can consume the reserve.
`maxWorkers` and configured RAM reservations remain bounds, including a cap of one for suites requiring serial execution.

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

`runTests` can share one `Admission` and `createSnapshotContext({ signal })`
across concurrent suites. Close those caller-owned resources after all suite
promises settle. Each file-snapshot handle drains its own calls on `close()` and
rejects subsequent snapshots without closing a shared context.

`createDiagnostics({ logger })` starts invocation-scoped resource sampling and
emits `TEST_DIAGNOSTIC` JSON records. Use `suiteStart`/`suiteEnd` for setup and
suite transitions, `span` for application stages, and `observeAdmission` for the
shared pool. Call `close(exitCode)` after cleanup. Observation does not drive
scheduler ticks or patch its methods.

### Progress and final summary

`runTests`, `runCachedUnits`, and `runChecks` print plain, newline-separated
progress and summary lines through their logger by default. Output remains
visible when redirected or piped to a log; it does not use terminal repainting.

```text
TEST_PROGRESS: 42 out of 100 test files finished | Skipped because cache: 12 | Failed: 1 | Timed out: 0 | Running: 4
TEST_SUMMARY: Tests run: 88 | Success: 85 | Skipped because cache: 12 | Failed: 2 | Timed out: 1 | Duration: 123.45s | FAIL
```

The total counts selected test files, including cached files, rather than
individual framework test cases or classes. Custom adapters count their units;
framework actions such as Playwright snapshot updates count one command unit.
Retries replace the original file outcome and do not count as additional tests.
The final `Timed out` count includes only verified timeouts still failing after
the configured retry; a successful retry counts as success. `Failed` excludes
these timeouts. Existing result objects retain their original semantics: their
`failed` count includes all nonzero file outcomes.

Updates are throttled to once per second as files change, with a heartbeat every
five seconds during long work. Failures and completion print immediately.
`Tests run` excludes cached files and includes interrupted files that started.
`Duration` covers discovery, setup, execution, retries, validation, and cleanup
for the invocation. A final validation error can produce `FAIL` even when every
test command succeeded. `logger: false` silences output; `progress: false`
suppresses only these progress and summary lines.

`runChecks` shares one overall counter across its test suites. For custom
multi-suite orchestration, pass one caller-owned reporter to every suite and
close it after validation and cleanup. Supply all selected suite IDs so progress
waits for their inventories before displaying a stable denominator:

```js
const progress = createProgress({ suites: ['unit', 'integration'] });
let exitCode = 2;
try {
  const results = await Promise.all([
    runTests({ ...unitConfig, suite: 'unit', progress }),
    runTests({ ...integrationConfig, suite: 'integration', progress }),
  ]);
  exitCode = results.find(result => result.exitCode)?.exitCode ?? 0;
} finally {
  progress.close(exitCode);
}
```

When sharing diagnostics instead, use
`createDiagnostics({ suites: ['unit', 'integration'] })`; its `close(exitCode)`
also closes the shared progress reporter. Use `progress: false` on diagnostics
to keep its logger's output limited to structured records.

With `durationHints: true`, fresh passes record source-bound durations separately
from passing evidence in `durations-<encoded-suite>.json`. Stable longest-first
ordering retains discovery order for unknown/equal durations. Cache hits retain
previous timings; input-changing or cancelled runs save no new hints. Disable
hints for runs whose execution mode should not reuse or replace those timings.

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
work drains. `runTests`, `runCachedUnits`, and `runCommand` share one temporary
SIGINT/SIGTERM listener pair while calls without an explicit `signal` are active.
Interrupts cancel those calls and stop admission; listeners are removed after
all default calls drain. An explicit signal remains caller-owned, including
forwarding it to commands started by custom callbacks.

On Linux and macOS, command cleanup owns an isolated process group. Generic
shell/npm commands get eight seconds for nested package owners to drain detached
workers, even if the shell exits first. Forced generic cleanup fails closed;
it cannot certify the nested workers or start a retry. Other platforms retain
direct-child termination for ordinary commands.

When `retryTimeouts` is enabled, verified Node timeouts and package wall deadlines
queue one complete-file retry after all normal files finish. Retries run serially;
with a shared `Admission`, an exclusive reservation also drains other active
commands and blocks new admissions until the retry closes. Independent processes
or pools are outside that reservation. Cancellation never starts a retry.
A second timeout fails. Ordinary assertion/hook failures are retained even when
the same file times out and its retry passes; that file receives no evidence.
Every attempt retains its console output. Only a complete passing retry against
the original unchanged inputs can supply evidence.

Node detection uses structured reporter failure types and causes, never test names
or printed output. Node 24 native hook deadlines are recognized when their hook
failure contains the exact timeout cause. A hook deliberately throwing that same
string is indistinguishable to Node's reporter and also retries once. A preload
observes the owned launcher/native test workers' process events while preserving
the original event result and Node's rejection/handler decisions; inherited fork
fixtures are excluded. This retains ordinary asynchronous failures that Node
otherwise reduces to informational diagnostics. Cancelled children of a verified
timed-out parent inherit that timeout. Hook failures without a matching
timeout cause remain failures without retry. Set `timeoutMs` to bound hung commands
in any framework; it does not classify ordinary framework failures.

Verified Node execution, Playwright execution, and wall deadlines require Linux
or macOS. Node attempts retain their two-second termination grace. Termination,
forced cleanup and quiescence checks cover inherited descendants even after the
launcher exits. Cleanup completes before admission is released or a retry begins. Unsupported platforms and unconfirmed
cleanup fail closed. Commands remain responsible for processes they deliberately
detach into other groups outside the package or native Playwright lifecycle.

For integrations that supply their own discovery and fingerprints, use
`runCachedUnits`:

```js
import { runCachedUnits } from 'project-checks';

const result = await runCachedUnits({
  cacheDirectory: '/project/.test-cache/custom',
  suite: 'custom',
  resources: {},
  units: [{ id: 'integration', identity: 'adapter-v1' }],
  snapshot: async () => ({
    common: await hashSharedInputs(),
    units: { integration: await hashIntegrationInputs() },
  }),
  execute: async unit => runIntegration(unit), // Return an integer exit code
});
```

Snapshots must include exactly the current unit IDs. Each unit needs a command
array or an execution label. `common` and each unit value contain only digests
of selected input existence and content. Adapters own their
discovery/fingerprint completeness and cancellation of their own commands.
Pass `resources: {}` without `workers` to select the package's adaptive admission
algorithm without local limits, just as `runTests` does. Fixture collectors need
no local worker pool. The low-level API retains its single-worker default when
both options are omitted.

To reuse JSON dependency mappings with custom fixtures, use the same snapshot
builder as `runTests`:

```js
import { createFileSnapshot, loadConfig, runCachedUnits } from 'project-checks';

const config = await loadConfig('checks.json');
const inputs = await createFileSnapshot(config);
try {
  const initial = await inputs.snapshot();
  const result = await runCachedUnits({
    cacheDirectory: '/project/.test-cache/fixtures',
    resources: {},
    units: Object.keys(initial.units).map(id => ({ id, identity: 'fixture-v1' })),
    snapshot: inputs.snapshot,
    execute: unit => runFixture(unit),
  });
  process.exitCode = result.exitCode;
} finally {
  await inputs.close();
}
```

`createFileSnapshot(config)` resolves defaults/root, preserves the full inventory
for `files` selection, and hashes existence and content of each own file and
mapped dependencies exactly as `runTests`. It does not run commands. Declare external fixture paths
with `testFixtureInputs` so the package hashes them. `close()` drains hashing
and rejects subsequent snapshots; always call it in `finally`.

### Retained fixture artifacts

`runCachedUnits` accepts two optional callbacks, supplied together:

- `restoreEvidence(unit, { files, metadata })` validates domain format, atomically
  materializes the contribution for this invocation, and returns `true`. The
  package checks file identities first; missing, corrupt or legacy bindings rerun
  the unit without calling this callback. Return `false` for incompatible domain
  format. A false return or error must leave no partial
  aggregate contribution; stage and clean up within the callback.
  After a successful restoration the package rechecks file identities. A change
  fails the invocation and removes passing evidence; no aggregation should follow.
- `saveEvidence(unit)` validates and persists the eligible passing artifact,
  returning `{ files: ['/absolute/artifact.json'], metadata: optionalDomainJSON }`.
  Declare a nonempty array of persisted regular files. The package rejects
  directories and symlinks before reading them, computes content hashes with its
  existing input walker, and stores the bindings in the same passing record.
  Artifact permission and ownership changes do not invalidate unchanged content.
  This runs only after a complete successful attempt against unchanged inputs.
  Throw on invalid artifacts. The package checks cancellation and source stability
  again after this callback before atomically publishing the existing pass record.

Both callbacks, including cache-hit materialization, hold package admission so an
exclusive retry cannot overlap their work. Errors reject the run after active
work drains. Metadata is stored in the existing pass record; do not put secrets in
it. With `cache: false`, restoration and record I/O are skipped, but `saveEvidence`
still validates current artifacts for aggregation and the package hashes their
declared files. Failed attempts and mixed
ordinary-failure retries never call it. Orphan artifact bytes without a matching
passing record are uncertified. Callbacks own artifact staging, atomic writes,
cleanup and cancellation of their own I/O. These low-level hooks support custom
artifacts; ordinary coverage uses the package's `coverage` configuration instead.
Artifact output must be excluded from source inputs.

Adapters may opt into `retryTimeouts` and accept `execute(unit, context)` where
`context.retry` identifies the second attempt and
`context.reportTimeout({ ordinaryFailure: boolean })` certifies a verified timeout
while preserving any observed ordinary failure. `execute` still returns an integer.
`runCommand` also retains its integer result: use `timeoutMs`, `nodeTest: true`
for direct Node test commands, or `playwrightTest: true` for a direct Playwright
CLI command, and `onTimeout: context.reportTimeout` to connect structured timeout
classification. Playwright attempts force one native worker and zero native
retries; the package owns concurrency and complete-file retries. The adapter
sets CLI reporters, overriding the Playwright configuration's `reporter` setting:
it uses `line` unless the command supplies `--reporter`. Pass artifact or custom
reporters explicitly through that CLI option; the package appends its structured
reporter to the same list. Native reporter events preserve mixed teardown failures.
Cancellation and wall deadlines signal the Playwright launcher for native teardown of its detached servers and browsers;
a second signal requests forced teardown after two seconds. If it still cannot
exit after another two seconds, the package fails closed without retry. `Admission.acquire({ exclusive: true, signal })` waits
for an exclusive slot; pair each successful acquire with `release()`.

The other exports are `defineConfig`, `loadConfig`, `runCommand`,
`cacheKey`, `cacheRecordName`, `detectResources` and `selectConcurrency`.
`cacheKey(snapshot, unitId)` is the single validity function used by the runner
and migration tools; `cacheRecordName(suite, unitId)` only locates records.

## Development

Native Playwright lifecycle regressions use an existing installation without
browser downloads: set `PROJECT_CHECKS_PLAYWRIGHT_ROOT` to its `playwright` package
directory when running `npm test`. These optional regressions start loopback
servers and need local-network permission.

```sh
npm test
npm run resources
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for release checks.


## OS CPU quota

On Linux, the CLI runner requires cgroup v2, `systemd-run`, and a running user
systemd manager with the CPU controller enabled. Before starting tests it creates
a unique user scope for the whole invocation, including the cache scan, and
verifies the kernel's `cpu.max`.
All descendants share its aggregate CPU budget, including detached workers.
Scope cleanup drains remaining descendants on exit or cancellation. Setup
failures stop the run rather than silently removing the quota.

On macOS, `run` and `checks` use adaptive scheduling without a kernel CPU quota.
Direct in-process APIs also use scheduling only; their entrypoint must be wrapped
with `runWithCpuQuota` or `project-checks exec` on Linux to acquire a kernel limit.

The package ships `project-checks.config.json` with its default test and resource
settings; absent project configuration uses these defaults. Copy that file into
your project to customize it. A local `project-checks.config.json` overrides the
packaged defaults field by field, including nested resource settings. Omitted
settings retain their defaults. Existing `project-checks.config.{mjs,js,json}`
files remain supported; an explicit `--config` selects a file directly.
Set `resources.cpuQuotaPercent` in your local configuration (or the existing
JavaScript config) to a number greater than 0 and at most 100; the default is 90.
On eight available CPUs, 90% allows 7.2 CPUs of aggregate time, measured in 10 ms
periods. Bursts within a period can use all CPUs; other processes can consume the
remaining capacity. Admission uses the same ceiling to avoid excessive launches.

```json
{ "resources": { "cpuQuotaPercent": 90 } }
```

Wrap custom test entrypoints, including compilation, with the same package quota:

```sh
project-checks exec --config project-checks.config.json -- node custom-runner.mjs
```

Programmatic entrypoints can call `runWithCpuQuota(command, { resources, cwd,
env, signal })`. Callback APIs such as `runCachedUnits` remain in-process; wrap
the entrypoint once rather than assigning a separate quota to every worker.
Systemd scope IDs are excluded from passing-cache identity. Nested invocations
reuse an existing equal or tighter inherited kernel quota;
its enclosing scope owner is responsible for detached-descendant cleanup. A
stricter quota inside a package-owned scope fails explicitly; configure the
outer runner instead.
