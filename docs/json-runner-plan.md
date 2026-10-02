# Declarative runner and cache defaults

Status: proposed, reviewed with Astra using minimal-code-discipline. This document
does not describe implemented behavior.

## Goal

Let a project install `project-checks`, declare its tests in one JSON file, and
run the CLI. The package owns resource tuning, input hashing, passing-test
caching, and coverage collection. Ordinary projects need no runner scripts or
manual input lists.

## Configuration and execution

Ship a generic defaults JSON containing `resources`, `suiteResources`, and
`numericalThreads`. Consumer configuration uses the same structure, overrides
only needed fields, and adds a `suites` map. Keep project-specific suite names
and resource costs in the consumer configuration.

For each suite, declare its framework and test paths, plus any necessary working
directory, Python interpreter, or framework configuration. Provide three small
built-in runners: Node, pytest, and Vitest. Resolve typed path options relative
to the project root; resolve the root relative to the configuration file.

Use `project-checks.config.json` as the conventional filename and retain
`--config <path>` for another location. Extend existing configuration loading and
validation. Merge documented objects explicitly; arrays replace rather than
merge. Resource precedence is package defaults, project `resources`, then
project `suiteResources[name]`.

Run suites sequentially through the existing discovery, scheduling, command,
and cache machinery. Preserve the flat single-suite API and custom-command
escape hatch. Built-ins enforce serial execution inside the framework so the
package owns file concurrency. Numerical thread limits come from configuration.

## Default retest rules

Discover runnable tests across all configured suites, including suites not
selected for the current invocation. Exclude independent runnable test files
from the shared fingerprint and hash each executed test separately. Hash the
remaining project inputs conservatively; do not infer dependency graphs.

| Change | Default behavior |
| --- | --- |
| Edit an independent test file | Rerun that file |
| Add a test file | Run the new file |
| Delete a test file | Remove it from selection; retain other passes |
| Change shared source, helpers, fixtures, framework configuration, or dependencies | Rerun all suites |
| Change execution commands, working directory, runtime, meaningful environment, or numerical threads | Invalidate affected execution evidence |
| Change resource limits, tuning, logging, or progress display | Retain evidence |
| Change package-owned cache, coverage, or log outputs, or Git metadata | Retain evidence |
| Touch a file without changing contents or meaningful permissions | Retain evidence |

Shared test helpers, including `conftest.py`, remain shared inputs. Runnable test
files must be independent. If another test imports one, use a narrow override
through existing input configuration to classify that file as shared. Keep
custom harness files as shared inputs when they can affect execution.

Separate execution identity from scheduling identity:

- Hash resolved execution settings rather than raw consumer configuration.
- Replace blanket runner-source hashing with an execution/cache contract
  identity. Maintainers update it when execution or evidence-validity changes
  can invalidate previous passes; scheduler and reporter edits leave it alone.
- Exclude only the identified `project-checks` installation from shared
  dependency hashing, replacing it with that contract identity. Normalize only
  its version/reference metadata in manifests and supported npm lock entries.
  Preserve other dependencies and manifest fields; never ignore whole lockfiles
  or `node_modules`.

Unsupported installation formats conservatively invalidate evidence. The
promise is that scheduling-only changes preserve evidence through the supported
configuration and npm installation path, not through arbitrary custom harnesses
or package managers. Hashing cannot infer whether arbitrary source edits change
execution semantics.

Keep unchanged-input checks before publishing evidence and before reporting
success, atomic evidence writes, cancellation, bounded path validation, and
existing failure handling. Live or externally stateful tests remain uncached.

## Coverage

Normal runs reuse passing-test evidence. `--coverage` performs a fresh, complete
run of each selected suite through its framework's coverage facility and emits
reports. Bypass passing-test evidence; do not label coverage from a newly
executed subset as complete coverage.

Use the project's installed frameworks and coverage providers. Supply collection
defaults in the package; allow threshold overrides without requiring consumer
collection scripts. Missing support fails with an actionable error. Automatic
coverage supports the three built-ins; unsupported custom-command coverage
fails explicitly.

## Implementation order and acceptance

1. Define execution versus scheduling identity, including narrow npm metadata
   normalization.
2. Separate independent test hashes from shared inputs.
3. Add defaults merging and declarative suites on the existing runner.
4. Move framework execution and full-suite coverage into the small built-ins.
5. Migrate Portfolio Mix configuration. Trace callers before removing wrappers;
   retain project-specific hooks still needed for live credentials or special
   execution.

Verify an edit matrix covering independent tests, shared helpers, numerical
threads, resource settings, reporter edits, scheduler-only package upgrades,
and real dependency changes. Retain concurrent-edit, cancellation, and atomic
publication regressions. Verify path resolution, invalid configuration, complete
coverage runs, and an independent installation containing the bundled defaults.

Keep the scope to these requirements. Do not add import/dependency graphs,
framework autodetection, initialization tools, plugin interfaces, general merge
libraries, new path placeholders, coverage persistence or merging, or universal
package-manager normalization. Add no new package dependencies.
