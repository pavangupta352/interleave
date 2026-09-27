import { EventEmitter } from 'node:events';
import net, { type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { postgresTlsOptions, restorePostgresTransport, type ResolvedPostgresTransport } from '../postgres-transport.js';

const messages = {
  'upstream-invalid-options': 'Upstream connection requires a positive bounded timeout and a valid cancellation signal.',
  'upstream-invalid-transport': 'Invalid upstream PostgreSQL transport configuration.',
  'upstream-aborted': 'Upstream PostgreSQL connection was cancelled.',
  'upstream-timeout': 'Upstream PostgreSQL connection exceeded its deadline.',
  'upstream-connection-failed': 'Could not connect to the upstream PostgreSQL server.',
  'upstream-closed': 'Upstream PostgreSQL closed before connection verification completed.',
  'upstream-tls-unavailable': 'Upstream PostgreSQL does not accept the required TLS connection.',
  'upstream-negotiation-failed': 'Upstream PostgreSQL returned an invalid TLS negotiation response.',
  'upstream-tls-handshake-failed': 'Upstream PostgreSQL TLS negotiation failed.',
  'upstream-tls-verification-failed': 'Upstream PostgreSQL certificate verification failed.',
  'upstream-certificate-name-mismatch': 'Upstream PostgreSQL certificate does not match the configured hostname or IP address.',
} as const;
type ErrorCode = keyof typeof messages;
export class UpstreamConnectionError extends Error {
  constructor(readonly code: ErrorCode) { super(messages[code]); this.name = 'UpstreamConnectionError'; }
}
const certificateErrors = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'INVALID_CA',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
]);
const certificateErrorPattern = /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|INVALID_PURPOSE|PATH_LENGTH_|ERR_TLS_CERT_)/;
function certificateFailure(code: unknown): boolean {
  return typeof code === 'string' && (certificateErrors.has(code) || certificateErrorPattern.test(code));
}
function tlsFailure(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'certificate-name-mismatch' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'upstream-certificate-name-mismatch';
  return certificateFailure(code) ? 'upstream-tls-verification-failed' : 'upstream-tls-handshake-failed';
}

/** Trust, negotiation and configuration failures; the rest may be transient. */
export const HARD_UPSTREAM_FAILURES: ReadonlySet<string> = new Set([
  'upstream-invalid-transport', 'upstream-tls-unavailable', 'upstream-negotiation-failed',
  'upstream-tls-handshake-failed', 'upstream-tls-verification-failed', 'upstream-certificate-name-mismatch',
]);

/**
 * A bounded diagnostic for a failed harness connection, without hosts, ports,
 * certificate details or credentials. Undefined when the failure is not recognized.
 */
export function connectionFailureMessage(error: unknown): string | undefined {
  if (error instanceof UpstreamConnectionError) return error.message;
  const failure = error as { name?: unknown; code?: unknown; message?: unknown } | undefined;
  if (failure?.name === 'PostgresTransportError' && typeof failure.message === 'string') return failure.message;
  const code = failure?.code;
  if (certificateFailure(code)) return 'PostgreSQL certificate verification failed. Supply the issuing CA with --upstream-ca or upstreamTls.ca.';
  if (failure?.message === 'The server does not support SSL connections') return 'PostgreSQL does not accept TLS connections; enable TLS on the server or omit --upstream-tls.';
  if (code === '28000' && typeof failure?.message === 'string' && failure.message.endsWith('no encryption')) return 'PostgreSQL requires TLS for this connection (pg_hba.conf hostssl); add --upstream-tls.';
  if (code === '28P01') return 'PostgreSQL rejected the password (28P01).';
  if (typeof code === 'string' && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(code)) {
    return `Could not connect to the PostgreSQL server (${code}).`;
  }
  return undefined;
}

/** Owns TCP/SSLRequest/TLS until verified handoff. It never accepts actor bytes. */
export async function connectPostgresUpstream(
  transport: ResolvedPostgresTransport,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Socket> {
  let timeoutMs: number, signal: AbortSignal | undefined;
  try {
    timeoutMs = options.timeoutMs === undefined ? 5_000 : options.timeoutMs;
    signal = options.signal;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
      || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error();
  } catch { throw new UpstreamConnectionError('upstream-invalid-options'); }
  if (signal?.aborted) throw new UpstreamConnectionError('upstream-aborted');
  let resolved: ResolvedPostgresTransport, tlsOptions: ReturnType<typeof postgresTlsOptions>;
  try { resolved = restorePostgresTransport(transport); tlsOptions = postgresTlsOptions(resolved); }
  catch { throw new UpstreamConnectionError('upstream-invalid-transport'); }

  return new Promise<Socket>((resolve, reject) => {
    let raw: Socket;
    try { raw = net.connect({ host: resolved.hostname, port: resolved.port }); }
    catch { reject(new UpstreamConnectionError('upstream-connection-failed')); return; }
    raw.setNoDelay(true);
    const rawClosed = new Promise<void>(done => raw.once('close', done));
    let secure: TLSSocket | undefined, secureClosed: Promise<void> | undefined;
    let settled = false;
    let phase: 'tcp' | 'negotiation' | 'handshake' = 'tcp';
    const timer = setTimeout(() => fail('upstream-timeout'), timeoutMs);
    function releaseListeners(): void {
      raw.off('connect', onConnect).off('data', onReply).off('error', onRawError).off('end', onClosed).off('close', onClosed);
      secure?.off('secureConnect', onSecure).off('error', onTlsError).off('end', onClosed).off('close', onClosed);
    }
    function stopDeadline(): void { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    function fail(code: ErrorCode): void {
      if (settled) return;
      settled = true;
      stopDeadline();
      raw.off('data', onReply);
      // Retain error listeners until both handles close; a late OS/TLS error must
      // not become an unhandled event while cancellation is settling.
      secure?.destroy();
      raw.destroy();
      void Promise.all([rawClosed, secureClosed]).then(() => {
        releaseListeners();
        reject(new UpstreamConnectionError(code));
      });
    }
    function handoff(socket: Socket): void {
      if (settled) return;
      if (signal?.aborted) { fail('upstream-aborted'); return; }
      settled = true;
      stopDeadline();
      resolve(socket);
      // Let the promise consumer install its handlers before removing ours.
      queueMicrotask(releaseListeners);
    }
    function onAbort(): void { fail('upstream-aborted'); }
    function onClosed(): void { fail('upstream-closed'); }
    function onRawError(error: Error): void { fail(phase === 'handshake' ? tlsFailure(error) : 'upstream-connection-failed'); }
    function onTlsError(error: Error): void { fail(tlsFailure(error)); }
    function onSecure(): void {
      if (!secure || settled) return;
      if (!secure.authorized) { fail('upstream-tls-verification-failed'); return; }
      // Explicitly verify the retained URL name at handoff as well as in Node's
      // handshake callback. No server-derived name or session can replace it.
      try {
        if (tlsOptions?.checkServerIdentity?.(resolved.hostname, secure.getPeerCertificate(true))) {
          fail('upstream-certificate-name-mismatch'); return;
        }
      } catch { fail('upstream-certificate-name-mismatch'); return; }
      handoff(secure);
    }
    function onReply(bytes: Buffer): void {
      if (settled) return;
      if (bytes.length !== 1) { fail('upstream-negotiation-failed'); return; }
      if (bytes[0] === 78) { fail('upstream-tls-unavailable'); return; }
      if (bytes[0] !== 83) { fail('upstream-negotiation-failed'); return; }
      raw.off('data', onReply);
      phase = 'handshake';
      try {
        secure = connectTls({ ...tlsOptions, socket: raw });
        secureClosed = new Promise<void>(done => secure!.once('close', done));
        secure.once('secureConnect', onSecure).on('error', onTlsError).once('end', onClosed).once('close', onClosed);
      } catch { fail('upstream-tls-handshake-failed'); }
    }
    function onConnect(): void {
      if (settled) return;
      if (!tlsOptions) { handoff(raw); return; }
      phase = 'negotiation';
      raw.on('data', onReply);
      // PostgreSQL SSLRequest: length 8, protocol request code 80877103.
      raw.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
    }
    raw.once('connect', onConnect).on('error', onRawError).once('end', onClosed).once('close', onClosed);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) fail('upstream-aborted');
  });
}

/**
 * Socket-shaped upstream whose verified stream arrives asynchronously. The proxy
 * keeps its synchronous state machine: writes before verification are retained in
 * order (the caller bounds writableLength), and pause/end/destroy requests apply
 * once the stream exists. A connector failure surfaces as one bounded 'error'
 * followed by 'close'; the connector has already closed its own sockets.
 */
export class DeferredUpstream extends EventEmitter {
  #socket: Socket | undefined;
  #pending: Buffer[] = [];
  #pendingBytes = 0;
  #end: { bytes?: Buffer } | undefined;
  #paused = false;
  #destroyed = false;
  readonly #abort = new AbortController();

  constructor(transport: ResolvedPostgresTransport, options: { timeoutMs?: number } = {}) {
    super();
    connectPostgresUpstream(transport, { ...options, signal: this.#abort.signal })
      .then(socket => this.#attach(socket), (error: unknown) => this.#fail(error));
  }

  get writableLength(): number { return this.#socket ? this.#socket.writableLength : this.#pendingBytes + (this.#end?.bytes?.length ?? 0); }

  write(bytes: Buffer): boolean {
    if (this.#socket) return this.#socket.write(bytes);
    if (!this.#destroyed && !this.#end) { this.#pending.push(bytes); this.#pendingBytes += bytes.length; }
    return true;
  }

  end(bytes?: Buffer): void {
    if (this.#socket) { if (bytes) this.#socket.end(bytes); else this.#socket.end(); }
    else this.#end ??= bytes ? { bytes } : {};
  }

  pause(): this { this.#paused = true; this.#socket?.pause(); return this; }
  resume(): this { this.#paused = false; this.#socket?.resume(); return this; }

  destroy(): this {
    if (this.#destroyed) return this;
    this.#destroyed = true; this.#pending = []; this.#pendingBytes = 0;
    if (this.#socket) this.#socket.destroy(); else this.#abort.abort();
    return this;
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    socket.on('error', (error: Error) => this.#emitError(error));
    // A reset between verified handoff and these listeners already emitted its events.
    if (socket.closed) {
      if (!this.#destroyed) this.#emitError(new UpstreamConnectionError('upstream-closed'));
      process.nextTick(() => this.emit('close'));
      return;
    }
    socket.once('close', () => this.emit('close'));
    if (this.#destroyed || socket.destroyed) {
      if (!this.#destroyed) this.#emitError(new UpstreamConnectionError('upstream-closed'));
      socket.destroy();
      return;
    }
    socket.on('data', (chunk: Buffer) => this.emit('data', chunk));
    socket.on('drain', () => this.emit('drain'));
    socket.on('end', () => this.emit('end'));
    if (this.#paused) socket.pause();
    const pending = this.#pending;
    this.#pending = []; this.#pendingBytes = 0;
    for (const bytes of pending) socket.write(bytes);
    if (this.#end) { const { bytes } = this.#end; if (bytes) socket.end(bytes); else socket.end(); }
  }

  #fail(error: unknown): void {
    this.#pending = []; this.#pendingBytes = 0;
    if (!this.#destroyed) this.#emitError(error instanceof UpstreamConnectionError ? error : new UpstreamConnectionError('upstream-connection-failed'));
    this.emit('close');
  }

  #emitError(error: Error): void { if (this.listenerCount('error') > 0) this.emit('error', error); }
}
