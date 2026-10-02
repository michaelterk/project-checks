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

Provide small Node, pytest, and Vitest runners. Suites declare test paths and
framework, plus necessary working directory, interpreter, or framework-config
paths. Resolve typed paths against the project root, itself resolved beside the
configuration file. Use `project-checks.config.json` or `--config <path>`.

Reuse existing validation, discovery, command execution, admission, and cache
machinery. Run suites sequentially and keep framework-internal file concurrency
serial. Preserve the flat API and custom-command escape hatch; built-ins supply
the ordinary integration path.

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

Discover runnable tests across all configured suites, including unselected ones.
Exclude independent test files from the shared hash and hash each separately.
Treat remaining inputs conservatively as shared; infer no dependency graphs.

| Change | Default behavior |
| --- | --- |
| Edit an independent test | Rerun that file |
| Add a test | Run the new file |
| Delete a test | Remove it; retain other passes |
| Change shared code, fixtures, helpers, framework configuration, or dependencies | Rerun all suites |
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

The package owns per-test deadlines and retries only confirmed timeouts. Allow
one additional attempt by default, with suite timeout/retry overrides. Ordinary
test failures, spawn errors, and cancellation retain their existing behavior.

Collect timed-out tests during the normal pass. Finish that queue and drain all
active workers before retrying timed-out tests one at a time. Retry concurrency
is one regardless of the normal worker cap; retries do not overlap normal tests.
Terminate and drain each timed-out attempt before another attempt, and obtain
live resource admission for every retry.

Keep retries bounded and report them. Preserve integer exit codes and the
existing result shape. Save evidence only after a complete successful attempt
with unchanged inputs. Reuse command cancellation/cleanup; add no general retry
framework.

## Coverage and JSON gates

Normal runs reuse evidence. `--coverage` freshly runs complete selected suites
through their installed framework/coverage provider and evaluates gates. Bypass
passing evidence; do not merge or persist per-file coverage. Missing providers
or unsupported custom-command coverage fail with actionable errors.

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

## Implementation and acceptance

1. Correct package-owned execution identity and independent/shared hashing,
   including the narrow npm normalization.
2. Add defaults merging and declarative suites around the existing runner.
3. Move framework execution, serial timeout retries, and coverage gates into
   built-ins.
4. Migrate consumers, starting with Portfolio Mix. Trace callers before removing
   generic cache/retry wrappers; retain bootstrap, live credentials, specialized
   artifact gates, and non-test concurrency consumers.

Verify retest rules with an edit matrix: independent test, shared helper,
numerical threads, resource settings, reporter edits, scheduler-only package
upgrades, and real dependency changes. Retain concurrent-edit, atomic-write,
cancellation, and resource-admission regressions. Check timeout recovery,
exhaustion, cleanup, and no overlap with normal tests or other retries; coverage
defaults, scoped gates, unsupported metrics, and complete uncached coverage
runs; path validation and installation with bundled defaults.

Keep the scope to these requirements. Add no import/dependency graphs, framework
autodetection, setup wizard, plugin interface, general merge library, new command
placeholders, coverage persistence/merging, universal package-manager
normalization, general retry framework, or new package dependencies.
