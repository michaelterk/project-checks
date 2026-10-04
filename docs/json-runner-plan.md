# Declarative runner and cache defaults

Status: implementation plan. Automatic admission, opt-in timeout retries, stable
cache identity, and scoped `testInputs`/focused selection now exist in the flat
configuration API; see README for their supported contracts. Declarative suites,
broader fingerprint changes, and retained coverage remain proposed.

## Goal

Install `project-checks`, declare suites in JSON, run the CLI. The package owns
resource tuning, fingerprints, passing evidence, timeout retries, and coverage
gates. Ordinary consumers supply configuration, not hashes or collection scripts.

## Configuration and execution

- Load `project-checks.config.json` or `--config <path>`. Resolve the project root
  beside the config; resolve typed paths against that root.
- Bundle defaults for `resources`, `suiteResources`, and `numericalThreads`.
  Merge documented objects explicitly; replace arrays. Resource precedence:
  package defaults, project resources, suite resources.
- Provide Node, unittest, pytest, and Vitest built-ins. Suites declare discovery,
  framework, and required cwd, interpreter, import/discovery, framework-config,
  and coverage-provider settings. Use installed runtimes and providers;
  existing unittest files need no rewrites or pytest dependency.
- Run suites sequentially; keep framework file concurrency serial. Retain the
  flat API and custom-command escape hatch. Reuse existing discovery,
  validation, execution, admission, and evidence handling.
- Continue selected suites after test or coverage-gate failures; return a
  nonzero final status. Cancellation stops admissions across suites, cleans up
  active work, and returns the cancellation status.
- Within-file name, skip, only, or case filters bypass complete-file passing and
  coverage evidence reads/writes and cannot certify suite gates. Complete-file
  subsets may reuse evidence; gates require complete current suite evidence.

## Resources

- Default to automatic tuning: start at half the available CPU budget, rounded
  down, minimum one; constrain by live RAM and configured caps.
- Sample CPU usage/pressure and available RAM/memory pressure. Gradually increase
  admissions with sustained headroom; reduce admissions under pressure. Active
  tests finish normally. Tuning stays local to the invocation.
- Require `reserveMemoryMiB` plus the next worker estimate before admission.
  Pause under memory pressure; retain the bounded wait when nothing can start.
  Sampled headroom cannot guarantee against every memory spike.
- Caps are ceilings. Use `maxWorkers: 1` for serial stages and existing limits
  for nested budgets. Advanced `runCachedUnits` callers pass resources and omit
  or clear workers. Explicit workers intentionally override automatic policy.

## Fingerprints and evidence

- Always call the package before accepting cached success. Replace outer generic
  test caches; retain unrelated deployment and artifact gates.
- Default `inputRoot` to the project root; allow suite scopes within it.
  Validate paths and stay inside declared boundaries. Support `inputs`/`ignore`
  overrides; exclude operational, runtime, and generated data before reading.
- Discover runnable tests across all suites, including unselected ones. Exclude
  independent tests from shared hashes and hash each separately. Other scoped
  inputs are shared; infer no dependency graph. Helpers such as `conftest.py`
  stay shared; imported runnable tests need explicit shared-input overrides.
  Custom harness files that affect execution remain inputs.
- Fingerprint declared runtime binaries and provider assets outside `inputRoot`
  through trusted paths, including the selected Python environment and provider,
  import, and discovery settings. Retain advanced callbacks for browser bundle
  discovery within declared paths.
- Hash resolved execution settings. Replace blanket runner-source hashing with
  an internal execution/cache contract identity, updated for validity changes,
  not scheduler or reporter edits. Normalize only the runner installation's
  version/reference in manifests and supported npm locks. Preserve other
  dependencies/fields; unsupported formats invalidate conservatively. Never
  ignore whole lockfiles or `node_modules`.
- Retain unchanged-input checks, atomic evidence writes, cancellation, path
  validation, and failure handling. Live/externally stateful tests stay uncached.

| Change | Evidence effect |
| --- | --- |
| Edit/add/delete an independent test | Rerun edited/new files; remove deleted files; retain other passes |
| Shared code, fixtures, helpers, framework config, dependencies | Invalidate affected suites |
| Command, cwd, runtime, meaningful environment, numerical threads, timeout/retry policy | Invalidate affected execution evidence |
| Resources, tuning, logging, display, scheduler/reporter-only package changes | Retain evidence |
| Cache/report/log outputs, Git metadata, content-preserving touches | Retain evidence; meaningful permission changes still invalidate |

## Timeout retries

- Preserve Node completion semantics: return without throwing, fulfill a promise,
  or complete a callback without error. Body return values are not exit statuses;
  low-level `execute` resolves to an integer exit code. Keep the result shape.
- Enforce a package wall deadline per file attempt, including hung processes.
  Internal test/hook timeouts require verified structured adapter signals.
  Node uses reporter events and verified causes; timeout names/text alone and
  unverifiable hook causes do not qualify. Parent summaries inherit child
  classification. Unittest uses the wall deadline; it has no native general
  internal-timeout signal.
- Verified timeouts retry even when mixed with ordinary failures, but observed
  ordinary failures remain failures and prevent evidence. Cancelled descendants
  of verified timed-out parents inherit the timeout; unrelated cancellations
  remain ordinary failures. Assertions, other hook errors, spawn/unknown failures
  do not independently trigger retry. A deadline cannot mask an observed ordinary
  failure. User cancellation never retries; package deadline cleanup is distinct.
- Default to one additional attempt; allow bounded suite overrides. Keep one
  retry owner: disable framework/consumer retries, or disable package retries
  for an advanced adapter that retains ownership.
- Finish the normal queue and drain workers before serial retries. Retry one
  file at a time, with live resource admission. Terminate and drain each attempt,
  descendants, and reporter output before another starts.
- Report every attempt. Successful recovery replaces that file's timeout result;
  other failures remain failures. Check against the original input baseline
  throughout; save evidence only after complete success with unchanged inputs.
  Reuse command cleanup.

## Coverage gates

- `--coverage` retains successful complete-file contributions from cacheable
  tests across failed or interrupted runs. Rerun failed/new/changed/invalidated
  files and files with missing/corrupt artifacts. Passing evidence cannot replace coverage artifacts.
  Failed/incomplete attempts contribute nothing.
- Use installed framework providers; missing providers and unsupported custom
  coverage fail explicitly. Unittest uses coverage.py through the selected
  interpreter, configured in suite JSON; enable branch collection when required.
- Evaluate lines, branches, and functions separately. Required unsupported
  metrics fail; never approximate or omit them. Before replacing function gates,
  verify native counts match consumer semantics and preserve declared thresholds.
- For Python executed-body function gates, exclude docstrings and directly
  nested function/class definitions and their bodies from eligible lines.
  Count each sync/async function with eligible lines; any executed eligible line
  covers it. Count nested functions separately. Use supported provider data;
  fail if exact counts are unavailable.
- Bind artifacts to test/source/execution inputs, the provider and its
  dependencies, and collection settings. Verify checksums; use the evidence guarantees above.
  Merge fresh/retained contributions for every current test, excluding
  deleted tests. Evaluate gates even when everything is cached; failures,
  missing/invalid contributions, or changed inputs prevent suite success.
- Each `coverageGates` entry names a file/folder `path` and percentage thresholds
  for `lines`, `branches`, and `functions`. Omitted thresholds default to 80;
  accepted values are 0–100. Resolve paths against the project root; aggregate
  covered/total counts per metric. Evaluate overlapping gates independently.
- Include all eligible source files under each path, subject to collection
  exclusions. Unexecuted files count as uncovered; use provider-supported source
  discovery/collection rather than only executed files. If the installed
  provider/runtime cannot supply complete counts, fail with an actionable error.
  Only after complete source discovery and supported measurement may a metric
  with zero eligible items be reported as not applicable without failing.
  Missing paths/data or unavailable required metrics are errors.
- Gate-only changes reevaluate retained coverage when sources/metrics are
  available. Collection changes invalidate artifacts. Consumers declare gates;
  package handlers collect, merge, and evaluate native reports.

## Example configuration

Proposed `project-checks.config.json`; not supported by the current release.
These Node suites require an installed coverage provider/runtime capable of
counting unexecuted source files. Use `inputs` for required shared code or
dependencies outside each `inputRoot`.

```json
{
  "root": ".",
  "resources": {
    "maxWorkers": 8,
    "memoryMiBPerWorker": 256,
    "reserveMemoryMiB": 512
  },
  "suiteResources": {
    "worker": { "memoryMiBPerWorker": 512 }
  },
  "numericalThreads": 1,
  "suites": {
    "api": {
      "framework": "node",
      "inputRoot": "apps/api",
      "testDirectory": "apps/api/test",
      "pattern": "**/*.test.mjs",
      "coverageGates": [
        { "path": "apps/api/src", "lines": 90, "branches": 85, "functions": 90 },
        { "path": "apps/api/src/critical", "lines": 95, "branches": 90, "functions": 95 }
      ]
    },
    "worker": {
      "framework": "node",
      "inputRoot": "apps/worker",
      "testDirectory": "apps/worker/test",
      "pattern": "**/*.test.mjs",
      "coverageGates": [
        { "path": "apps/worker/src" }
      ]
    }
  }
}
```

Run `project-checks --config project-checks.config.json --coverage`.

## Implementation and acceptance

1. Correct scoped hashing and package execution identity, including narrow npm
   normalization.
2. Add defaults and declarative built-ins, including unittest runtime settings.
3. Add verified timeout handling, serial retries, retained coverage, and gates.
4. Migrate consumers. Trace callers before removing generic cache/retry wrappers;
   retain bootstrap, live credentials, specialized artifact gates, and non-test
   concurrency consumers.

Test the contracts above, including the edit matrix and failure paths. Retain
concurrent-edit, atomic-write, cancellation, and resource-admission regressions.
Verify installation with bundled defaults and parse/exercise the example.
Before migrating Python function gates, check parity for executed/uncalled,
single-line, async, docstring-only, nested functions, and nested classes.

No dependency graphs, autodetection, setup wizard, plugin interface, general
merge library, new placeholders, persistence layer, universal package-manager
normalization, retry framework, or new package dependencies.
