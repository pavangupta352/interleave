import type { Client } from 'pg';
import type { FixtureIdentity, FixtureIdentityProfile } from './fixture-identity.js';
import type { SourceIdentity } from './source-identity.js';

export type ProtocolKind = 'simple' | 'extended';
export type ProtocolProfile = 'sync-cycle-v1' | 'describe-flush-v1';
export type StepStage = 'complete' | 'describe' | 'execute' | 'recover';
export type TransactionStatus = 'I' | 'T' | 'E';
export type Outcome = 'passed' | 'violation' | 'actor-error' | 'incompatible' | 'inconclusive' | 'harness-error';

export interface DatabaseContext {
  db: Client;
  connectionString: string;
}

export interface ActorContext {
  actor: string;
  connectionString: string;
  signal: AbortSignal;
}

export interface ActorResult {
  actor: string;
  status: 'fulfilled' | 'rejected';
  value?: unknown;
  error?: string;
}

export interface Scenario {
  name: string;
  setup(context: DatabaseContext): Promise<void>;
  actors: Record<string, (context: ActorContext) => Promise<unknown>>;
  invariant(context: DatabaseContext & { results: ActorResult[] }): Promise<void>;
}

export interface ReadyCompletion {
  /** Required in version 2 artifacts; absent in original version 1 records. */
  kind?: 'ready';
  transactionStatus: TransactionStatus;
  commandTags: string[];
  rowCount: number;
  error?: { code: string; message: string };
}

export type MetadataCompletion = {
  kind: 'metadata';
  transactionStatus?: never;
  commandTags?: never;
  rowCount?: never;
} & ({
  result: 'described';
  parameterCount: number;
  columnCount: number;
  resultShape: 'rows' | 'no-data';
  error?: never;
} | {
  result: 'error';
  error: { code: string; message: string };
  parameterCount?: never;
  columnCount?: never;
  resultShape?: never;
});

export type UnitCompletion = ReadyCompletion | MetadataCompletion;

export interface PendingUnit {
  actor: string;
  connection: number;
  ordinal: number;
  protocol: ProtocolKind;
  sql: string;
  fingerprint: string;
  backendPid: number;
  stage?: StepStage;
  cycle?: number;
  prefixOrdinal?: number;
  release(): Promise<UnitCompletion>;
}

export interface ConnectionIdentity {
  actor: string;
  connection: number;
  fingerprint: string;
}

export type ProxyEvent =
  | { type: 'startup'; actor: string; connection: number; fingerprint: string }
  | { type: 'connected'; actor: string; connection: number; backendPid: number }
  | { type: 'disconnected'; actor: string; connection: number };

export interface ProxyOptions {
  upstreamUrl: string;
  actor: string;
  onUnit(unit: PendingUnit): void;
  onEvent?(event: ProxyEvent): void;
  onError(error: Error): void;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  /** Total live sessions, including queryless auxiliaries; integer 1..8, default 1. */
  maxConnectionsPerActor?: number;
  protocolProfile?: ProtocolProfile;
}

export interface ActorProxy {
  connectionString: string;
  close(): Promise<void>;
}

export interface WaitObservation {
  pid: number;
  blockerPids: number[];
  waitEvent: string;
  waitEventType: string;
}

export interface OwnedDatabase {
  name: string;
  connectionString: string;
  db: Client;
  serverVersion: string;
  observeWait(backendPid: number): Promise<WaitObservation | null>;
  close(): Promise<void>;
}

export interface StepIdentity {
  actor: string;
  connection: number;
  ordinal: number;
  protocol: ProtocolKind;
  sql: string;
  fingerprint: string;
  /** Explicit for every version 2 step; omitted by version 1. */
  stage?: StepStage;
  cycle?: number;
  prefixOrdinal?: number;
}

export interface TraceStep extends StepIdentity {
  index: number;
  backendPid: number;
  available: string[];
  releasedAt: number;
  completedAt?: number;
  completion?: UnitCompletion;
  waits: WaitObservation[];
}

export interface Failure {
  name: string;
  message: string;
  fingerprint: string;
}

export interface RunResult {
  schemaVersion: 1 | 2;
  scenario: string;
  outcome: Outcome;
  mode: 'explore' | 'replay' | 'guided';
  plan: string[];
  /** Accepted actor startup attempts. Optional only for reading legacy artifacts. */
  connections?: ConnectionIdentity[];
  trace: TraceStep[];
  actors: ActorResult[];
  failure?: Failure;
  reason?: string;
  environment: { serverVersion: string; nodeVersion: string; fixture?: FixtureIdentity; source?: SourceIdentity };
  startedAt: string;
  durationMs: number;
  limits: { maxSteps: number; timeoutMs: number; maxEvidenceBytes?: number; maxConnectionsPerActor?: number; protocolProfile?: ProtocolProfile };
  cleanup: { complete: boolean; error?: string };
}

export interface RunOptions {
  databaseUrl: string;
  /** Select the catalog capture contract; native is the default. */
  fixtureProfile?: FixtureIdentityProfile;
  /** Selected local files for supervised file runs; imported modules are also captured. */
  source?: { projectRoot?: string; include?: string[] };
  plan?: string[];
  replay?: RunResult;
  /** @internal Bind starting conditions without requiring an identical query schedule. */
  expectedEnvironment?: RunResult['environment'];
  mode?: 'explore' | 'replay' | 'guided';
  maxSteps?: number;
  timeoutMs?: number;
  maxEvidenceBytes?: number;
  /** Permit queryless auxiliary sessions; at most one live session may issue commands. */
  maxConnectionsPerActor?: number;
  /** Opt in to separately scheduled Parse/Describe/Flush and Bind/Execute/Sync phases. */
  protocolProfile?: ProtocolProfile;
  signal?: AbortSignal;
}

export interface ExploreOptions extends RunOptions {
  /** FIFO preserves insertion order; supplying a seed opts into seeded selection. */
  strategy?: ExplorationStrategy;
  /** Deterministic uint32 frontier seed; required for seeded, forbidden for FIFO. */
  seed?: number;
  maxRuns?: number;
  stopOnFailure?: boolean;
  totalTimeoutMs?: number;
  maxCandidates?: number;
  maxSearchBytes?: number;
}

export type ExplorationStrategy = 'fifo' | 'seeded';

/** Versioned frontier selection; exact replay still consumes a RunResult trace. */
export type ExplorationSearch =
  | { version: 1; strategy: 'fifo'; seed?: never }
  | { version: 1; strategy: 'seeded'; seed: number };

export interface ExplorationMetrics {
  /** Dispatched runs, including incomplete executions and omitted artifacts. */
  attemptedRuns: number;
  /** Valid passed, violation or actor-error runs with complete trace and cleanup. */
  completedRuns: number;
  /** Longest explicit actor prefix actually dispatched; initial fair [] is zero. */
  maxAttemptedDepth: number;
  /** Validated trace entries before retention, including describe/execute/recover. */
  recordedReleasedSteps: number;
  /** Adjacent actor changes within each validated trace, never across runs. */
  recordedActorSwitches: number;
  /** False means trace counters are lower bounds from partial recorded evidence. */
  traceCountsComplete: boolean;
}

export interface ExplorationResult {
  schemaVersion: 1;
  scenario: string;
  search: ExplorationSearch;
  metrics: ExplorationMetrics;
  runs: RunResult[];
  firstFailure?: RunResult;
  explored: number;
  pending: number;
  retainedBytes: number;
  omittedRuns: number;
  violationCount: number;
  hardFailureCount: number;
  stopReason: 'failure' | 'max-runs' | 'frontier-exhausted' | 'inconclusive' | 'aborted' | 'deadline' | 'max-candidates' | 'max-search-bytes';
  coverage: string;
}

export interface MinimizeOptions extends RunOptions {
  maxAttempts?: number;
  totalTimeoutMs?: number;
}

export interface MinimizationResult {
  originalChoices: number;
  reducedChoices: number;
  attempts: number;
  locallyMinimal: boolean;
  plan: string[];
  run: RunResult;
  /** The first hard failed attempt; run remains the last reproduced violation. */
  attemptFailure?: {
    outcome: 'actor-error' | 'harness-error';
    reason?: string;
    cleanup: RunResult['cleanup'];
  };
  stopReason: 'locally-minimal' | 'max-attempts' | 'deadline' | 'aborted' | 'inconclusive';
  reason?: string;
}
