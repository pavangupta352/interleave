import net, { type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { BackendSummary } from './protocol/backend.js';
import { FrameDecoder, DEFAULT_BUFFER_LIMIT, positiveLimit } from './protocol/framing.js';
import { FrontendAssembler, FrontendCycleBuffer, type FrontendUnit } from './protocol/frontend.js';
import type { ActorProxy, PendingUnit, ProxyEvent, ProxyOptions, UnitCompletion } from './types.js';

function errorResponse(message: string): Buffer {
  const payload = Buffer.from(`SFATAL\0VFATAL\0C0A000\0M${message}\0\0`);
  const head = Buffer.alloc(5); head[0] = 69; head.writeUInt32BE(payload.length + 4, 1);
  return Buffer.concat([head, payload]);
}
function startupParameters(frame: Buffer): { fields: Map<string, string>; fingerprint: string } {
  const fields = new Map<string, string>(); let offset = 8;
  const identity = createHash('sha256').update('postgres-startup-v1\0');
  while (offset < frame.length && frame[offset] !== 0) {
    const keyEnd = frame.indexOf(0, offset); const valueEnd = frame.indexOf(0, keyEnd + 1);
    if (keyEnd < 0 || valueEnd < 0) throw new Error('Malformed startup parameters');
    const key = frame.toString('utf8', offset, keyEnd);
    if (key === 'database' && fields.has(key)) {
      throw new Error('Malformed startup parameters: duplicate database parameter');
    }
    fields.set(key, frame.toString('utf8', keyEnd + 1, valueEnd));
    // Keep exact ordered field bytes, including duplicate keys. Only the assigned
    // disposable database name varies between otherwise identical runs.
    if (key !== 'database') identity.update(frame.subarray(offset, valueEnd + 1));
    offset = valueEnd + 1;
  }
  if (offset !== frame.length - 1) throw new Error('Malformed startup terminator');
  return { fields, fingerprint: identity.digest('hex') };
}

/** Actor-specific plaintext inspecting PostgreSQL proxy. Never re-executes SQL. */
export async function createProxy(options: ProxyOptions): Promise<ActorProxy> {
  let upstreamUrl: URL;
  try { upstreamUrl = new URL(options.upstreamUrl); } catch { throw new Error('Invalid PostgreSQL upstream URL'); }
  if (!['postgres:', 'postgresql:'].includes(upstreamUrl.protocol)) throw new Error('Invalid PostgreSQL upstream URL scheme');
  if (!upstreamUrl.hostname || !upstreamUrl.pathname.slice(1)) throw new Error('PostgreSQL upstream URL needs a host and explicit database');
  const sslMode = upstreamUrl.searchParams.get('sslmode');
  if ((sslMode && sslMode !== 'disable') || ['ssl', 'sslcert', 'sslkey', 'sslrootcert'].some(p => upstreamUrl.searchParams.has(p))) throw new Error('Unsupported profile: upstream TLS; use an explicitly plaintext disposable PostgreSQL server');
  const maxConnections = options.maxConnectionsPerActor === undefined ? 1 : options.maxConnectionsPerActor;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 8) throw new Error('maxConnectionsPerActor must be an integer between 1 and 8');
  const maxBuffered = positiveLimit(options.maxBufferedBytes, DEFAULT_BUFFER_LIMIT);
  // Validate framing limits before listening.
  new FrameDecoder('typed', options);
  interface Session { shutdown(): void; closed: Promise<void> }
  const sockets = new Set<Socket>(); const sessions = new Set<Session>();
  let commandOwner: Session | undefined;
  let generation = 0; let closing = false; let closePromise: Promise<void> | undefined;
  const notifyError = (error: Error): void => { try { options.onError(error); } catch { /* Consumer errors must never escape a socket event. */ } };
  const notifyEvent = (event: ProxyEvent): void => { try { options.onEvent?.(event); } catch { notifyError(new Error('Proxy event callback failed')); } };
  function track(socket: Socket): void { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
  function rejectSocket(socket: Socket, error: Error): void {
    notifyError(error); socket.end(errorResponse(error.message));
    const timer = setTimeout(() => socket.destroy(), 100); timer.unref(); socket.once('close', () => clearTimeout(timer));
  }
  const server = net.createServer(client => {
    track(client); client.setNoDelay(true);
    if (closing) { client.destroy(); return; }
    if (sessions.size >= maxConnections) {
      rejectSocket(client, new Error(maxConnections === 1
        ? 'Unsupported profile: one simultaneous physical connection per actor is supported'
        : `Unsupported profile: physical connection limit per actor is ${maxConnections}`));
      return;
    }
    const connection = generation++; let ordinal = 0; let backendPid = 0; let startupFingerprint = '';
    let started = false; let ready = false; let negotiated = false; let terminated = false; let failed = false;
    let closed = false; let clientClosed = false; let upstreamClosed = false; let retainedBytes = 0;
    let pendingTerminate: Buffer | undefined;
    const frontend = new FrameDecoder('startup', options); const backend = new FrameDecoder('typed', options); const assembler = new FrontendAssembler(options); const cycles = new FrontendCycleBuffer(options);
    const upstream = net.connect({ host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 5432) }); track(upstream); upstream.setNoDelay(true);
    interface Queued { frames: Buffer[]; byteLength: number; ordinal: number; unit?: PendingUnit }
    const queue: Queued[] = [];
    let inFlight: { original: FrontendUnit; summary: BackendSummary; errorSeen: boolean; resolve(value: UnitCompletion): void; reject(error: Error): void } | undefined;
    function shutdown(): void {
      if (closed) return; closed = true;
      const outstanding = Boolean(inFlight || queue.length || cycles.bufferedBytes);
      const current = inFlight; inFlight = undefined; current?.reject(new Error('Proxy connection closed before command completion'));
      queue.length = 0; retainedBytes = 0;
      // A protocol error rejects the driver's active query before TCP close, allowing
      // the actor's finally block to close its client without an idle error event.
      if (outstanding && !client.destroyed) client.end(errorResponse('Interleave actor proxy closed before command completion'));
      upstream.destroy();
    }
    let resolveClosed!: () => void;
    const session: Session = { shutdown, closed: new Promise<void>(resolve => { resolveClosed = resolve; }) };
    sessions.add(session);
    function fail(error: Error): void {
      if (failed || closed) return; failed = true; notifyError(error);
      const current = inFlight; inFlight = undefined; current?.reject(error);
      queue.length = 0; retainedBytes = 0; upstream.destroy();
      client.end(errorResponse(error.message));
      const timer = setTimeout(shutdown, 100); timer.unref(); client.once('close', () => clearTimeout(timer));
    }
    function guard(work: () => void): void {
      try { work(); } catch (error) { fail(error instanceof Error ? error : new Error('Proxy protocol processing failed')); }
    }
    function write(destination: Socket, bytes: Buffer, source: Socket): void {
      if (!destination.write(bytes)) source.pause();
      if (destination.writableLength > maxBuffered) throw new Error('Protocol outbound buffered-byte limit exceeded');
    }
    upstream.on('drain', () => { if (!closed && !failed) client.resume(); });
    client.on('drain', () => { if (!closed && !failed) upstream.resume(); });
    function announce(): void {
      if (!ready || failed || closed || inFlight) return;
      const entry = queue[0];
      if (!entry || entry.unit) return;
      // Never publish identity derived from a preceding cycle's unacknowledged intent.
      const proposed = assembler.fork();
      let original: FrontendUnit | undefined;
      for (const frame of entry.frames) original = proposed.accept(frame);
      if (!original) throw new Error('Incomplete frontend scheduling unit');
      const retained = original;
      if (!startupFingerprint) throw new Error('Actor startup identity was not established');
      let released = false;
      const unit: PendingUnit = {
        actor: options.actor, connection, ordinal: entry.ordinal, protocol: retained.protocol,
        sql: retained.sql,
        fingerprint: createHash('sha256').update(`interleave-session-v1\0${startupFingerprint}\0${retained.fingerprint}`).digest('hex'), backendPid,
        release(): Promise<UnitCompletion> {
          if (released) return Promise.reject(new Error('Scheduling unit already released'));
          if (closed || failed || closing) return Promise.reject(new Error('Proxy connection closed before release'));
          if (!ready || inFlight || queue[0] !== entry) return Promise.reject(new Error('Scheduling units must release in connection order after prior completion'));
          released = true; queue.shift(); retainedBytes -= entry.byteLength;
          return new Promise<UnitCompletion>((resolve, reject) => {
            inFlight = { original: retained, summary: new BackendSummary(), errorSeen: false, resolve, reject };
            guard(() => write(upstream, retained.bytes, client));
          });
        },
      };
      entry.unit = unit;
      try { options.onUnit(unit); } catch { fail(new Error('Proxy scheduling callback failed')); }
    }
    function enqueue(frames: Buffer[]): void {
      const byteLength = frames.reduce((total, frame) => total + frame.length, 0);
      retainedBytes += byteLength;
      if (retainedBytes + cycles.bufferedBytes + frontend.bufferedBytes > maxBuffered) throw new Error('Protocol queued buffered-byte limit exceeded');
      queue.push({ frames, byteLength, ordinal: ordinal++ });
      announce();
    }
    client.on('data', chunk => guard(() => {
      for (const frame of frontend.push(chunk)) {
        if (closed || failed) break;
        if (!started) {
          const version = frame.readUInt32BE(4);
          if (version === 80877103 || version === 80877104) {
            if (frame.length !== 8) throw new Error('Malformed encryption negotiation request');
            negotiated = true; client.write('N'); continue;
          }
          if (version === 80877102) throw new Error('Unsupported profile: PostgreSQL cancellation routing');
          if (version !== 196608) throw new Error('Unsupported profile: only PostgreSQL protocol 3.0 is supported');
          const startup = startupParameters(frame); const params = startup.fields;
          if (params.has('replication') && params.get('replication') !== 'false') throw new Error('Unsupported profile: replication');
          if (params.get('database') !== decodeURIComponent(upstreamUrl.pathname.slice(1))) throw new Error('Unsupported profile: actor startup database differs from its assigned database');
          startupFingerprint = startup.fingerprint;
          started = true;
          notifyEvent({ type: 'startup', actor: options.actor, connection, fingerprint: startupFingerprint });
          write(upstream, frame, client); continue;
        }
        const type = String.fromCharCode(frame[0]!);
        if (terminated) throw new Error('Actor sent protocol data after Terminate');
        if (type === 'p' && !ready) { write(upstream, frame, client); continue; }
        if (type === 'X') {
          if (frame.length !== 5) throw new Error('Malformed Terminate message');
          if (queue.length || cycles.bufferedBytes || (inFlight && !inFlight.errorSeen)) throw new Error('Actor disconnected with unfinished scheduled work');
          terminated = true;
          // Drivers may reject on ErrorResponse and close before ReadyForQuery.
          // Drain that actual completion even after the frontend has gone away.
          if (inFlight) { pendingTerminate = frame; upstream.resume(); }
          else upstream.end(frame);
          continue;
        }
        // Reserve on the first command frame, including an incomplete extended
        // cycle. Buffered commands before ReadyForQuery reserve ownership too,
        // but authentication and Terminate never turn an auxiliary into an owner.
        if (commandOwner && commandOwner !== session) throw new Error('Unsupported profile: only one live command-producing connection per actor is supported; close the previous command connection before another sends commands');
        commandOwner = session;
        const unit = cycles.accept(frame);
        if (unit) enqueue(unit);
        if (retainedBytes + cycles.bufferedBytes + frontend.bufferedBytes > maxBuffered) throw new Error('Protocol queued buffered-byte limit exceeded');
      }
    }));
    upstream.on('data', chunk => guard(() => {
      for (const frame of backend.push(chunk)) {
        if (closed || failed) break;
        const type = String.fromCharCode(frame[0]!);
        if ('GHW'.includes(type)) throw new Error('Unsupported profile: streaming COPY');
        if (type === 'K') {
          if (frame.length !== 13) throw new Error('Unsupported backend key format');
          backendPid = frame.readInt32BE(5); // Deliberately never retain or emit the secret key.
        }
        if (type === 'E' && inFlight) inFlight.errorSeen = true;
        if (type === 'Z' && !ready) {
          if (!backendPid) throw new Error('Backend did not provide its process identity');
          ready = true; notifyEvent({ type: 'connected', actor: options.actor, connection, backendPid });
          write(client, frame, upstream); announce(); continue;
        }
        if (inFlight) assembler.reconcile(inFlight.original, frame);
        const completion = inFlight?.summary.accept(frame);
        if (!terminated) write(client, frame, upstream);
        if (completion && inFlight) {
          const current = inFlight; inFlight = undefined; current.resolve(completion);
          if (pendingTerminate) { const frame = pendingTerminate; pendingTerminate = undefined; upstream.end(frame); }
          else announce();
        }
      }
    }));
    client.on('error', () => { if (!closing && !terminated && !failed) fail(new Error('Actor client connection failed')); });
    upstream.on('error', () => { if (!closing && !failed && (!terminated || inFlight)) fail(new Error('PostgreSQL upstream connection failed')); });
    client.on('end', () => {
      if (closing || failed || closed) return;
      if (negotiated && !started) fail(new Error('Unsupported profile: TLS/GSS encryption required; configure this local actor connection with ssl:false'));
      else if (!terminated && (inFlight || queue.length || cycles.bufferedBytes || frontend.bufferedBytes)) fail(new Error('Actor disconnected with unfinished scheduled work'));
      else if (pendingTerminate) return;
      else upstream.end();
    });
    upstream.on('end', () => {
      if (closed) return;
      if (!closing && !failed && (inFlight || queue.length || (!terminated && ready))) fail(new Error('PostgreSQL upstream disconnected unexpectedly'));
      else client.end();
    });
    function finishClose(): void {
      if (!clientClosed || !upstreamClosed) return;
      closed = true;
      sessions.delete(session);
      if (commandOwner === session) commandOwner = undefined;
      notifyEvent({ type: 'disconnected', actor: options.actor, connection });
      resolveClosed();
    }
    client.on('close', () => {
      clientClosed = true;
      if (!closing && !failed && !terminated && !closed && (inFlight || queue.length || cycles.bufferedBytes)) fail(new Error('Actor disconnected with unfinished scheduled work'));
      if (!pendingTerminate) upstream.destroy();
      finishClose();
    });
    upstream.on('close', () => {
      upstreamClosed = true;
      if (!closed && !closing && !failed && inFlight) fail(new Error('PostgreSQL upstream disconnected unexpectedly'));
      if (!closed && !client.writableEnded && !failed) client.destroy();
      finishClose();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error('Unable to listen on loopback for actor proxy'));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  server.on('error', () => notifyError(new Error('Actor proxy listener failed')));
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Actor proxy did not bind a TCP endpoint'); }
  const endpoint = new URL(upstreamUrl); endpoint.hostname = '127.0.0.1'; endpoint.port = String(address.port);
  // URL query transport overrides must not bypass the actor endpoint.
  for (const field of ['host', 'hostaddr', 'port']) endpoint.searchParams.delete(field);
  return { connectionString: endpoint.toString(), close(): Promise<void> {
    if (closePromise) return closePromise; closing = true;
    closePromise = (async () => {
      const accepted = [...sessions];
      const listenerClosed = new Promise<void>(resolve => { server.close(() => resolve()); });
      for (const session of accepted) session.shutdown();
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 100); timer.unref();
      try { await Promise.all([listenerClosed, ...accepted.map(session => session.closed)]); }
      finally { clearTimeout(timer); }
    })(); return closePromise;
  } };
}
