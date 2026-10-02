# Declarative runner and cache defaults

Status: implementation plan, reviewed with Astra using minimal-code-discipline,
with subsequent user decisions incorporated. Automatic resource admission
already exists; the configuration, cache, retry, and coverage changes below
remain proposed.

## Goal

A project installs `project-checks`, declares tests in one JSON file, and runs
the CLI. The package owns automatic resource tuning, live-memory admission,
fingerprinting, passing-test caching, timeout retries, and coverage gates.
Ordinary consumers need no fingerprint callbacks, manual input lists, retry
loops, or coverage collection scripts.

## Configuration and execution

Ship generic defaults with `resources`, `suiteResources`, and `numericalThreads`.
Consumer JSON overrides needed fields and adds a `suites` map. Suite names and
project-specific costs stay in consumer configuration. Merge documented objects
explicitly; arrays replace. Resource precedence is package defaults, project
`resources`, then `suiteResources[name]`.

Provide small Node, Python unittest, pytest, and Vitest runners. Suites declare
test paths and framework, plus necessary working directory, interpreter, or
framework-config paths. Resolve typed paths against the project root, itself
resolved beside the configuration file. Use `project-checks.config.json` or
`--config <path>`.

The `unittest` built-in runs existing Python test files unchanged with the
configured installed interpreter, app working directory, and import/discovery
settings. Declare these and provider configuration in suite JSON; ordinary
adoption needs no custom runner, callback, test rewrites, or pytest dependency.
Bind the selected Python environment and discovery/import/provider settings into
the existing scoped fingerprints and per-file evidence.

Reuse existing validation, discovery, command execution, admission, and cache
machinery. Run suites sequentially and keep framework-internal file concurrency
serial. Preserve the flat API and custom-command escape hatch; built-ins supply
the ordinary integration path.

Runs using within-file name, skip, only, or case filters bypass reading and
writing complete-file passing and coverage evidence. Such runs cannot certify
the full file or a suite gate. Selecting fewer complete files can retain normal
per-file reuse when execution meaning is unchanged; suite gates still require
complete current evidence.

## Automatic resource maximization

Automatic tuning and live-memory admission are required defaults:

- Start at half the available CPU budget, rounded down with a minimum of one,
  constrained by live RAM and configured caps.
- Sample CPU usage, CPU pressure, available RAM, and memory pressure. Increase
  concurrency gradually under sustained spare capacity; reduce future admissions
  under sustained pressure. Active tests finish normally.
- Require `reserveMemoryMiB` plus the next worker's RAM estimate before admission.
  Pause under memory pressure; retain the bounded wait when no work can start.
  Sampled headroom cannot guarantee against every memory spike.
- Keep tuning run-local and automatic, without people or AI adjusting weights.
  Worker caps are ceilings, not fixed counts or targets.
- Apply this policy through the default entrypoint. Advanced `runCachedUnits`
  integrations pass `resources` and omit or clear `workers`. Express serial
  stages as `maxWorkers: 1` and nested budgets through existing resource limits.
  Explicit workers remain an intentional override, not the adoption default.

## Package-owned fingerprinting

The package discovers inputs and computes execution, dependency, and package
identities. Consumers do not build hashes or bind runner identities themselves.
Always call the package before accepting cached test success. Replace generic
outer test caches that can bypass it; retain unrelated deployment/artifact gates.
Use the existing evidence engine rather than adding another cache layer.

Suites may set an `inputRoot` within the project, defaulting to the project root,
and reuse `inputs`/`ignore` overrides for shared inputs and exclusions. Validate paths
against the project root; discovery must stay within declared boundaries.
Exclude operational data, runtime state, and generated output before reading or
hashing files, using defaults and project-specific exclusions. An unrelated app
outside a suite's inputs must not invalidate its evidence.

Configured runtime binaries and provider assets outside `inputRoot` remain
execution inputs for the suites that use them. Fingerprint the selected contents
through explicitly declared trusted paths. Reuse advanced fingerprint/snapshot
callbacks for browser-specific bundle discovery, limited to those paths;
preserve source exclusions and scoped discovery boundaries.

Discover runnable tests across all configured suites, including unselected ones,
then fingerprint each suite's declared inputs. Exclude independent test files
from its shared hash and hash each separately. Treat remaining inputs
conservatively as shared within that scope; infer no dependency graphs.

| Change | Default behavior |
| --- | --- |
| Edit an independent test | Rerun that file |
| Add a test | Run the new file |
| Delete a test | Remove it; retain other passes |
| Change shared code, fixtures, helpers, framework configuration, or dependencies | Rerun affected suites |
| Change commands, working directory, runtime, meaningful environment, numerical threads, or timeout/retry policy | Invalidate affected execution evidence |
| Change resource limits, tuning, logging, or progress display | Retain evidence |
| Change package-owned cache, report, or log outputs, or Git metadata | Retain evidence |
| Touch a file without changing contents or meaningful permissions | Retain evidence |

Helpers such as `conftest.py` remain shared. Runnable tests must be independent;
an imported runnable test needs a narrow shared-input override. Custom harness
files that affect execution remain inputs. Keep low-level snapshot callbacks as
an advanced escape hatch, without requiring them for normal adoption.

Hash resolved execution settings rather than raw configuration. Replace blanket
runner-source hashing with an internal execution/cache contract identity;
maintainers update it for validity changes, not scheduler or reporter edits.
Replace only the identified runner installation with that identity, normalizing
its version/reference metadata in manifests and supported npm lock entries.
Preserve all other dependencies and fields. Unsupported formats conservatively
invalidate; never ignore whole lockfiles or `node_modules`.

Retain unchanged-input checks, atomic evidence writes, cancellation, path
validation, and failure handling. Live or externally stateful tests stay uncached.

## Serial timeout retries

Ordinary Node test bodies follow [`node:test` completion rules](https://nodejs.org/docs/latest-v24.x/api/test.html#test-runner):
a synchronous body returns without throwing, an async body's promise fulfills,
or a callback completes without an error. Exceptions, rejected promises,
assertion failures, and hook errors fail the test. Returning `0` or `1` from a
test body is not an exit-status API. The low-level `execute` callback instead
resolves to an integer process exit code; preserve that contract and the runner's
existing result shape.

The package owns a wall deadline for each test-file attempt, including blocked
or hung processes. Its expiry confirms a timeout but cannot override an observed
non-timeout failure. Recognize internal test or hook timeouts only through
positively identified structured signals from supported framework adapters.
The Node adapter uses reporter events and verified failure causes; hook failures
whose timeout cause cannot be verified remain ordinary failures without retry.
Parent failure summaries inherit their children's classification. An error named
`TimeoutError` or timeout text alone is not proof.

Stdlib [`unittest`](https://docs.python.org/3/library/unittest.html#command-line-interface)
has no general internal-timeout classification. Its built-in
uses the package wall deadline; any supported internal-timeout signal must meet
the same positive verification rules.

Assertions, other hook errors, spawn errors, and unknown or mixed failures prevent
timeout-only retry. Cancelled child tests block file retry even when their parent
or suite has a confirmed timeout. User cancellation never retries; termination
performed by the package to clean up its own deadline is distinct.

Allow one additional attempt by default, with bounded suite timeout/retry
overrides. Each suite has one retry owner: disable framework/consumer retries
when the package owns them, or disable package retries for an advanced adapter
that retains ownership.

Collect timed-out tests during the normal pass. Finish that queue and drain all
active workers before retrying timed-out tests one at a time. Retry concurrency
is one regardless of the normal worker cap; retries do not overlap normal tests.
Terminate and drain each timed-out attempt, including its child processes and
reporter output, before another attempt. Obtain live resource admission for
every retry.

Keep retries bounded and report every attempt. A successful retry replaces that
file's initial timeout result; unrecovered and unrelated failures still fail the
suite. Check inputs against the original baseline throughout both stages; never
adopt changed inputs as a new retry baseline. Save evidence only after a complete
successful attempt with unchanged inputs. Reuse command cancellation/cleanup;
add no general retry framework.

## Coverage and JSON gates

Normal runs reuse passing evidence. `--coverage` retains per-file coverage from
complete successful executions of cacheable tests, including across failed or
interrupted runs. Rerun failed, new, changed, or invalidated files and files whose
coverage artifacts are missing or corrupt, using the installed framework/coverage
provider. Passing-test evidence alone cannot skip missing coverage collection.
Missing providers or unsupported custom-command coverage fail with actionable
errors.

For `unittest`, use installed [coverage.py](https://coverage.readthedocs.io/en/latest/commands/cmd_run.html)
through the selected interpreter to collect and combine per-file artifacts under
the retention rules below. Suite JSON supplies provider configuration. Native
measurement covers statements and, when enabled, branches; enable branch
collection when gates require it. Evaluate each declared metric separately. If
the installed provider cannot supply a required function or other metric, fail
explicitly instead of approximating or dropping it.

[coverage.py 7.6+ provides per-function JSON](https://coverage.readthedocs.io/en/7.10.2/changes.html#version-7-6-0-2024-07-11).
Before migrating function gates, verify that native provider counts match the
consumer's metric semantics; preserve its declared thresholds. For gates based
on executed body lines, exclude docstrings and directly nested function/class
definition statements, including their bodies, from each function's eligible
lines. Count each synchronous or asynchronous function with at least one eligible
line; it is covered if any such line executed. Count nested functions separately.
Reuse supported provider data; fail clearly if accurate required counts are
unavailable.

Bind artifacts to test, source, and execution inputs, the coverage provider and its
dependencies, and collection settings. Verify artifact checksums before reuse;
save successful contributions with the existing unchanged-input checks and
atomic evidence guarantees. Failed or incomplete attempts supply no coverage.

Merge fresh and retained contributions for every current test in each selected
suite, then evaluate all gates, including when every contribution was cached.
Exclude deleted tests. Never report suite success while a test has failed, a
required contribution is missing or invalid, or inputs have changed.

Each suite may declare `coverageGates`. A gate has a source file/directory path
and named percentage thresholds for lines, branches, and functions. Every
omitted threshold defaults to 80; values must be between 0 and 100.

```json
{
  "coverageGates": [
    { "path": "src" },
    { "path": "src/critical", "lines": 90, "branches": 85, "functions": 90 }
  ]
}
```

Gate paths resolve against the project root. Aggregate covered/total counts
over matching source files for each metric; evaluate overlapping gates
independently. Missing paths, absent coverage, or unavailable required metrics
fail explicitly rather than silently passing. Use native reports and small
framework handlers; consumers supply configuration, not parsing or gate code.

Changes only to gate criteria reevaluate retained contributions without rerunning
tests when the artifacts cover the requested sources and metrics. Changes to
collection settings invalidate affected artifacts.

## Implementation and acceptance

1. Correct package-owned execution identity and independent/shared hashing
   within suite input boundaries, including the narrow npm normalization.
2. Add defaults merging and declarative suites around the existing runner,
   including native unittest interpreter, import/discovery, and provider settings.
3. Move framework execution, verified timeout classification and serial retries,
   retained coverage contributions, and coverage gates into built-ins.
4. Migrate consumers, starting with Portfolio Mix. Trace callers before removing
   generic cache/retry wrappers; retain bootstrap, live credentials, specialized
   artifact gates, and non-test concurrency consumers.

Verify retest rules with an edit matrix: independent test, shared helper,
numerical threads, resource settings, reporter edits, scheduler-only package
upgrades, and real dependency changes. Retain concurrent-edit, atomic-write,
cancellation, and resource-admission regressions. Verify unrelated app isolation,
declared shared inputs, and operational/runtime/generated-input exclusions.
Check partial-file filters cannot reuse or certify complete-file passing/coverage
evidence, complete-file subset reuse, and external runtime/asset changes
invalidating affected suites while retaining unrelated app evidence.
Check Node completion semantics, verified internal timeouts, unverifiable hook
failures, wall deadlines, mixed failures, and children cancelled by parent
timeouts. Check retry recovery/exhaustion, original-input validation, cleanup,
and no overlap or duplicate retry ownership.

Check coverage defaults, scoped gates, unsupported metrics, retained successes
after failure/interruption, failed/new/changed-file reruns, missing/corrupt
artifacts, provider/collection invalidation, deleted tests, complete aggregation
with fresh/reused contributions, and gate reevaluation on all-cached runs and
criteria changes. Retain path validation and installation with bundled defaults.

Exercise existing unittest files with configured interpreter/cwd/import settings,
scoped evidence reuse/invalidation, wall-deadline retries, and retained coverage.py
artifacts. Verify provider absence, branch collection, exact per-metric gates,
and unsupported required metrics using the same coverage acceptance cases.
Check Python function-count parity for executed/uncalled bodies, single-line and
async functions, docstring-only bodies, and nested functions/classes before
replacing consumer gates.

Keep the scope to these requirements. Add no import/dependency graphs, framework
autodetection, setup wizard, plugin interface, general merge library, new command
placeholders, general persistence layer, universal package-manager normalization,
general retry framework, or new package dependencies.
