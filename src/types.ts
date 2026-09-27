import type { Client, ClientConfig } from 'pg';
import type { FixtureIdentity, FixtureIdentityProfile } from './fixture-identity.js';
import type { SourceIdentity } from './source-identity.js';
import type { ResolvedPostgresTransport, TransportIdentity, UpstreamTlsInput } from './postgres-transport.js';

export type ProtocolKind = 'simple' | 'extended';
export type ProtocolProfile = 'sync-cycle-v1' | 'describe-flush-v1';
/** Single-producer allows one live command connection per actor; multi-producer schedules every connection as a lane. */
export type ConnectionProfile = 'single-producer-v1' | 'multi-producer-v1';
export type StepStage = 'complete' | 'describe' | 'execute' | 'recover';
export type TransactionStatus = 'I' | 'T' | 'E';
export type Outcome = 'passed' | 'violation' | 'actor-error' | 'incompatible' | 'inconclusive' | 'harness-error';

export interface DatabaseContext {
  /** Connected node-postgres client for the generated database. */
  db: Client;
  /** URL of the generated database. It cannot carry an in-memory private CA. */
  connectionString: string;
  /** Fresh node-postgres configuration for additional clients, including verified TLS. */
  readonly connectionOptions: ClientConfig;
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
  /** Resolved upstream policy; its connection string must equal upstreamUrl. Plaintext when omitted. */
  upstreamTransport?: ResolvedPostgresTransport;
  actor: string;
  onUnit(unit: PendingUnit): void;
  onEvent?(event: ProxyEvent): void;
  onError(error: Error): void;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  /** Total live sessions, including queryless auxiliaries; integer 1..8, default 1. */
  maxConnectionsPerActor?: number;
  protocolProfile?: ProtocolProfile;
  /** multi-producer-v1 lets every admitted session send commands; default single-producer-v1. */
  connectionProfile?: ConnectionProfile;
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
  /** Private resolved transport for this generated database; never serialized into evidence. */
  transport: ResolvedPostgresTransport;
  /** Fresh node-postgres configuration on each access. */
  readonly connectionOptions: ClientConfig;
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
  /** Actor ids that could proceed; version 4 records connection lanes such as `alice#1`. */
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

/** Selected upstream policy, not proof that a failed attempt established TLS. */
export interface RunTransportIdentity {
  version: 1;
  frontend: 'loopback-plaintext-v1';
  authentication: 'passthrough-no-channel-binding-v1';
  upstream: TransportIdentity;
}

export interface RunResult {
  /** Version 4 records the multi-producer connection profile; 1-3 remain readable. */
  schemaVersion: 1 | 2 | 3 | 4;
  scenario: string;
  outcome: Outcome;
  mode: 'explore' | 'replay' | 'guided';
  /** Actor choices; version 4 may name a connection lane, such as `alice#1`. */
  plan: string[];
  /** Accepted actor startup attempts. Optional only for reading legacy artifacts. */
  connections?: ConnectionIdentity[];
  trace: TraceStep[];
  actors: ActorResult[];
  failure?: Failure;
  reason?: string;
  environment: { serverVersion: string; nodeVersion: string; fixture?: FixtureIdentity; source?: SourceIdentity; transport?: RunTransportIdentity };
  startedAt: string;
  durationMs: number;
  limits: {
    maxSteps: number; timeoutMs: number; maxEvidenceBytes?: number; maxConnectionsPerActor?: number; protocolProfile?: ProtocolProfile;
    /** Present, and required, only in version 4. */
    connectionProfile?: ConnectionProfile;
  };
  cleanup: { complete: boolean; error?: string };
}

export interface RunOptions {
  databaseUrl: string;
  /** Verify the upstream certificate chain and URL hostname/IP for every PostgreSQL connection. */
  upstreamTls?: UpstreamTlsInput;
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
  /** Admitted connection cap per actor: 1..8; default 1, or 8 for multi-producer-v1. */
  maxConnectionsPerActor?: number;
  /** Opt in to separately scheduled Parse/Describe/Flush and Bind/Execute/Sync phases. */
  protocolProfile?: ProtocolProfile;
  /** Opt in to scheduling every admitted actor connection as its own sequential lane. */
  connectionProfile?: ConnectionProfile;
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
