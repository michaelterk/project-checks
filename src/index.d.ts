export interface ResourcePolicy {
  cpuPercent?: number;
  /** Aggregate OS CPU cap as a percentage of available CPUs. Default: 90; range (0, 100]. */
  cpuQuotaPercent?: number;
  reserveCpus?: number;
  /** Free RAM headroom to retain before admitting another worker, in MiB. */
  reserveMemoryMiB?: number;
  /** Static selectConcurrency estimate; automatic runs tune their own CPU weight. */
  cpusPerWorker?: number;
  memoryMiBPerWorker?: number;
  maxWorkers?: number;
  divisor?: number;
}

export interface HostResources {
  cpus: number;
  /** Inherited kernel CPU-time limit, when detected; Infinity means unbounded. */
  cpuQuotaCpus?: number;
  memoryMiB: number;
}

export interface Concurrency extends HostResources {
  divisor: number;
  cpuBudget: number;
  memoryBudgetMiB: number;
  workers: number;
}

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface TestConfig {
  /** Project root. Defaults to cwd; loadConfig resolves it beside the config file. */
  root?: string;
  /** JSON configuration inherited before local field overrides. */
  extends?: string;
  /** One directory containing the test files. Default: test. */
  testDirectory?: string;
  /** Globs relative to testDirectory. Default: **\/*.test.{js,mjs,cjs}. */
  pattern?: string | string[];
  /** Select IDs from the full configured inventory without changing dependency discovery. */
  files?: string[];
  /** Argument array with {file} placeholders; executed directly without a shell. */
  command?: string[] | ((id: string) => string[]);
  /** Shared input paths/globs, relative to root. Default: every project file. */
  inputs?: string[];
  /** Additive dependencies by root-relative test ID or folder prefix ending in '/'. */
  testInputs?: Record<string, string[]> | ((id: string) => string[] | Promise<string[]>);
  /** Exclude runnable tests from dependency folders/globs, keeping each own test identity. */
  excludeTestsFromInputs?: boolean;
  /** Exclusions relative to root. Replaces default .git/.test-cache/__pycache__ exclusions. */
  ignore?: string[];
  /** Worker cap; omitted starts at half the CPU budget and tunes within resource caps. */
  workers?: number;
  resources?: ResourcePolicy;
  cache?: boolean;
  cacheDirectory?: string;
  /** Stable project identity for deliberate cache reuse across equivalent checkouts. */
  cacheIdentity?: string;
  /** Retry each verified timeout file once, after normal work drains. Default: false. */
  retryTimeouts?: boolean;
  /** Node default test timeout on retry; explicit test timeouts still apply. Default: 60000. */
  retryTimeoutMs?: number;
  /** Wall deadline per command attempt, in milliseconds. Omitted means no deadline. */
  timeoutMs?: number;
  suite?: string;
  /** Overrides inherited environment; undefined removes a variable. */
  env?: Record<string, string | undefined>;
  ignoreEnv?: string[];
  /** Extra identity for external runtimes, dependencies, services or other inputs. */
  fingerprint?: () => string | Promise<string>;
  /** Declare literal fixture files/directories, root-relative or absolute. The package hashes them. */
  testFixtureInputs?: (id: string) => string[] | Promise<string[]>;
  signal?: AbortSignal;
  logger?: Logger | false;
  stdio?: 'inherit' | 'ignore';
  /** Reuse invocation-owned resources; caller closes after every suite settles. */
  admission?: Admission;
  snapshotContext?: SnapshotContext;
  diagnostics?: Diagnostics;
  /** Share invocation progress across suites; false suppresses plain-text progress. */
  progress?: TestProgress | false;
  /** Learn source-bound longest-first hints separately from passing evidence. Default: false. */
  durationHints?: boolean;
  initialDurations?: Record<string, number>;
  select?: { include?: string[]; exclude?: string[] } | ((id: string) => boolean);
  filters?: string[];
  normalizeNpmEnvironment?: boolean;
  frameworkArgs?: string[];
  engine?: 'node' | 'playwright' | 'command';
  coverage?: false | CoverageConfig;
  setup?: (context: { signal: AbortSignal }) => CheckFixture | Promise<CheckFixture>;
}

export interface UnitResult {
  id: string;
  exitCode: number;
  cached: boolean;
}

export interface RunResult {
  exitCode: number;
  total: number;
  /** Fresh commands that exited zero; check exitCode/inputsChanged for suite validity. */
  passed: number;
  failed: number;
  cached: number;
  /** Peak fresh concurrency for adaptive runs; selected pool size otherwise. */
  workers: number;
  inputsChanged: boolean;
  results: UnitResult[];
}

export interface TestUnit {
  id: string;
  command?: string[];
  identity?: string;
}

export interface InputSnapshot {
  common: string;
  units: Record<string, string>;
}

export interface FileSnapshot {
  snapshot(): Promise<InputSnapshot>;
  /** Drain hashing and release resources; subsequent snapshots reject. */
  close(): Promise<void>;
}

/** Plain, losslessly JSON-serializable artifact references; never secrets. */
export type EvidenceMetadata = null | boolean | number | string | EvidenceMetadata[] | { [key: string]: EvidenceMetadata };

export interface EvidenceFiles {
  /** Persisted regular files, as absolute literal paths. Package computes and checks identities. */
  files: string[];
  metadata?: EvidenceMetadata;
}

/** One invocation-owned pool; close only after every sharing suite has settled. */
export class Admission {
  constructor(policy: ResourcePolicy, units: number, options?: { host?: HostResources; signal?: AbortSignal; workers?: number });
  /** Maximum queued workers, bounded by explicit workers and resource caps. */
  readonly capacity: number;
  /** Current CPU-feedback limit; may fall below an explicit worker cap. */
  readonly limit: number;
  active: number;
  peak: number;
  acquire(options?: { exclusive?: boolean; signal?: AbortSignal }): Promise<void>;
  release(): void;
  close(): void;
  report(logger: Logger | null, suite: string): void;
  inspect(): Record<string, unknown>;
}

export interface CachedUnitsOptions<T extends TestUnit = TestUnit> {
  progress?: TestProgress | false;
  cacheDirectory?: string;
  suite?: string;
  units: T[];
  snapshot(): InputSnapshot | Promise<InputSnapshot>;
  execute(unit: T, context: { retry: boolean; reportTimeout(outcome: { ordinaryFailure: boolean }): void }): number | Promise<number>;
  retryTimeouts?: boolean;
  /** Called only after package validates file bindings. Validate domain format and atomically
   * materialize artifacts; false/error must leave no partial contribution. */
  restoreEvidence?(unit: T, evidence: EvidenceFiles): boolean | Promise<boolean>;
  /** Paired with restoreEvidence. Persist/validate domain artifacts and declare their files.
   * Also called with cache:false; package checks files but stores no passing record. */
  saveEvidence?(unit: T): EvidenceFiles | Promise<EvidenceFiles>;
  workers?: number;
  /** Adjusts CPU admission during fresh work, including explicit worker caps. */
  resources?: ResourcePolicy;
  /** Reuse one pool across suites; the caller owns its final close. */
  admission?: Admission;
  environment?: Record<string, string | undefined>;
  ignoreEnv?: string[];
  cache?: boolean;
  signal?: AbortSignal;
  logger?: Logger | null;
  diagnostics?: Diagnostics;
}

export interface CommandOptions {
  cwd?: string;
  /** Complete environment, rather than overrides. Defaults to the inherited environment. */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stdio?: 'inherit' | 'ignore';
  logger?: Logger | null;
  timeoutMs?: number;
  /** Attach a structured Node test reporter; command must directly invoke node --test. */
  nodeTest?: boolean;
  /** Direct Playwright test CLI: structured outcomes, one worker, no native retries.
   * Overrides configured reporters with line unless CLI --reporter is supplied.
   * Mutually exclusive with nodeTest. Requires Linux or macOS. */
  playwrightTest?: boolean;
  /** Override the Node default test timeout; only used with nodeTest. */
  testTimeoutMs?: number;
  onTimeout?(outcome: { ordinaryFailure: boolean }): void;
}

export function defineConfig(config: TestConfig): TestConfig;
export function loadConfig(filename?: string, options?: { cwd?: string }): Promise<TestConfig>;
export function runTests(config?: TestConfig): Promise<RunResult>;
/** Reuse runTests JSON input normalization and hashing; caller must close in finally.
 * Does not execute tests or bind commands/environment; runCachedUnits owns those identities. */
export function createFileSnapshot(config?: TestConfig): Promise<FileSnapshot>;
export function runCachedUnits<T extends TestUnit>(options: CachedUnitsOptions<T>): Promise<RunResult>;
export function runCommand(command: string[], options?: CommandOptions): Promise<number>;
export function environmentIdentity(environment?: Record<string, string | undefined>, ignoreEnv?: string[]): string;
export function detectResources(): HostResources;
export function selectConcurrency(policy?: ResourcePolicy, resources?: HostResources): Concurrency;

/** Linux user-systemd scope covering this command and all descendant processes. */
export function runWithCpuQuota(command: string[], options?: { resources?: ResourcePolicy; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; stdio?: 'inherit' | 'ignore' }): Promise<number>;

/** Opaque hashing queue and content memoization shared by file snapshots. */
export interface SnapshotContext {
  close(): Promise<void>;
}
export interface Diagnostics {
  readonly progress?: TestProgress | false;
  event(event: string, fields?: Record<string, unknown>): void;
  suiteStart(suite: string, total?: number): void;
  suiteEnd(suite: string): void;
  files(suite: string, total: number): void;
  file(suite: string, file: string, event: string, fields?: Record<string, unknown>): void;
  span<T>(suite: string | null, stage: string, operation: () => T | Promise<T>, fields?: Record<string, unknown>): Promise<T>;
  observeAdmission(admission: Admission): void;
  close(exitCode: number): void;
}
export function createSnapshotContext(options?: { signal?: AbortSignal }): SnapshotContext;
export function createDiagnostics(options?: { logger?: Logger | false; suites?: string[]; progress?: false }): Diagnostics;

export interface TestProgress {
  files(suite: string, total: number): void;
  file(suite: string, file: string, event: string, fields?: { status?: number | string; timedOut?: boolean }): void;
  close?(exitCode: number): void;
}
/** Caller-owned reporter; supply all suite IDs to wait for a stable combined total. */
export function createProgress(options?: { logger?: Logger | false | null; suites?: string[] }): TestProgress & { close(exitCode: number): void };

export interface CoverageConfig {
  provider?: 'v8' | 'python';
  /** Each omitted metric defaults to 80, independently. */
  minimum?: { lines?: number; branches?: number; functions?: number };
  include?: string[];
  exclude?: string[];
  python?: string;
  configFile?: string;
  report?: string;
}
export interface CheckFixture {
  execute?: (command: string[], options: CommandOptions & { retry: boolean; reportTimeout: (details: { ordinaryFailure: boolean }) => void }) => Promise<number>;
  close?: () => void | Promise<void>;
}
export interface CheckDefinition {
  id: string;
  dependsOn?: string[];
  config?: string | TestConfig | ((context: { signal: AbortSignal }) => TestConfig | Promise<TestConfig>);
  command?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  verify?: () => void | Promise<void>;
}
export function loadChecks(filename: string, options?: {
  target?: string | string[]; files?: string[]; filters?: string[]; cache?: boolean; prefix?: string; frameworkArgs?: string[];
}): Promise<CheckDefinition[]>;
export function runChecks(definitions: CheckDefinition[], options?: {
  resources?: ResourcePolicy; workers?: number; signal?: AbortSignal; logger?: Logger | false;
  progress?: TestProgress | false;
}): Promise<{ exitCode: number; results: Array<{ id: string; exitCode: number; skipped?: boolean }> }>;
export function reportCoverage(config: TestConfig): Promise<null | {
  suite: string; minimum: { lines: number; branches: number; functions: number };
  actual?: { lines: number; branches: number; functions: number }; stale: boolean; measuredAt?: string;
}>;
