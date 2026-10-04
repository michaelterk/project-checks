export interface ResourcePolicy {
  cpuPercent?: number;
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
  /** One directory containing the test files. Default: test. */
  testDirectory?: string;
  /** Globs relative to testDirectory. Default: **\/*.test.{js,mjs,cjs}. */
  pattern?: string | string[];
  /** Argument array with {file} placeholders; executed directly without a shell. */
  command?: string[];
  /** Shared input paths/globs, relative to root. Default: every project file. */
  inputs?: string[];
  /** Exclusions relative to root. Replaces default .git/.test-cache/__pycache__ exclusions. */
  ignore?: string[];
  /** Fixed override; omitted starts at half the CPU budget and tunes within resource caps. */
  workers?: number;
  resources?: ResourcePolicy;
  cache?: boolean;
  cacheDirectory?: string;
  suite?: string;
  /** Overrides inherited environment; undefined removes a variable. */
  env?: Record<string, string | undefined>;
  ignoreEnv?: string[];
  /** Extra identity for external runtimes, dependencies, services or other inputs. */
  fingerprint?: () => string | Promise<string>;
  signal?: AbortSignal;
  logger?: Logger | false;
  stdio?: 'inherit' | 'ignore';
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

/** One invocation-owned pool; close only after every sharing suite has settled. */
export class Admission {
  constructor(policy: ResourcePolicy, units: number, options?: { host?: HostResources; signal?: AbortSignal; workers?: number });
  readonly capacity: number;
  readonly limit: number;
  active: number;
  peak: number;
  acquire(): Promise<void>;
  release(): void;
  close(): void;
  report(logger: Logger | null, suite: string): void;
}

export interface CachedUnitsOptions<T extends TestUnit = TestUnit> {
  cacheDirectory?: string;
  suite?: string;
  units: T[];
  snapshot(): InputSnapshot | Promise<InputSnapshot>;
  execute(unit: T): number | Promise<number>;
  workers?: number;
  /** Automatically adjusts CPU weight during fresh work when workers is omitted. */
  resources?: ResourcePolicy;
  /** Reuse one pool across suites; the caller owns its final close. */
  admission?: Admission;
  environment?: Record<string, string | undefined>;
  ignoreEnv?: string[];
  cache?: boolean;
  signal?: AbortSignal;
  logger?: Logger | null;
}

export interface CommandOptions {
  cwd?: string;
  /** Complete environment, rather than overrides. Defaults to the inherited environment. */
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stdio?: 'inherit' | 'ignore';
  logger?: Logger | null;
}

export function defineConfig(config: TestConfig): TestConfig;
export function loadConfig(filename?: string, options?: { cwd?: string }): Promise<TestConfig>;
export function runTests(config?: TestConfig): Promise<RunResult>;
export function runCachedUnits<T extends TestUnit>(options: CachedUnitsOptions<T>): Promise<RunResult>;
export function runCommand(command: string[], options?: CommandOptions): Promise<number>;
export function environmentIdentity(environment?: Record<string, string | undefined>, ignoreEnv?: string[]): string;
export function detectResources(): HostResources;
export function selectConcurrency(policy?: ResourcePolicy, resources?: HostResources): Concurrency;
