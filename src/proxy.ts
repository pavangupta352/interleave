import net, { type Socket } from 'node:net';
import { createHash, type Hash } from 'node:crypto';
import { resolvePostgresTransport, restorePostgresTransport } from './postgres-transport.js';
import { connectPostgresUpstream, DeferredUpstream, UpstreamConnectionError } from './protocol/upstream-transport.js';
import { BackendSummary, FlushSummary, MetadataSummary } from './protocol/backend.js';
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
  // One resolved policy per proxy; every upstream session verifies it independently.
  const transport = options.upstreamTransport === undefined
    ? resolvePostgresTransport(options.upstreamUrl) : restorePostgresTransport(options.upstreamTransport);
  if (options.upstreamTransport !== undefined && upstreamUrl.toString() !== transport.connectionString) {
    throw new Error('PostgreSQL upstream URL differs from its resolved transport');
  }
  const maxConnections = options.maxConnectionsPerActor === undefined ? 1 : options.maxConnectionsPerActor;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 8) throw new Error('maxConnectionsPerActor must be an integer between 1 and 8');
  const profile = options.protocolProfile === undefined ? 'sync-cycle-v1' : options.protocolProfile;
  if (profile !== 'sync-cycle-v1' && profile !== 'describe-flush-v1' && profile !== 'flush-stages-v1') throw new Error('protocolProfile must be sync-cycle-v1, describe-flush-v1 or flush-stages-v1');
  const staged = profile !== 'sync-cycle-v1';
  // Every Flush ends a release; the cycle stays open, between stages, until its Sync.
  const flushStages = profile === 'flush-stages-v1';
  const connectionProfile = options.connectionProfile === undefined ? 'single-producer-v1' : options.connectionProfile;
  if (connectionProfile !== 'single-producer-v1' && connectionProfile !== 'multi-producer-v1') throw new Error('connectionProfile must be single-producer-v1 or multi-producer-v1');
  // Each admitted session is already sequential; multi-producer lets every one send commands.
  const multiProducer = connectionProfile === 'multi-producer-v1';
  const maxBuffered = positiveLimit(options.maxBufferedBytes, DEFAULT_BUFFER_LIMIT);
  // Validate framing limits before listening.
  new FrameDecoder('typed', options);
  interface Session { shutdown(): void; closed: Promise<void>; isTerminating(): boolean; backendPid(): number; connection(): number | undefined }
  interface Replacement { client: Socket; retiring: Session; chunks: Buffer[]; bytes: number; detach(): void }
  type Tracked = Socket | DeferredUpstream;
  const sockets = new Set<Tracked>(); const sessions = new Set<Session>();
  let commandOwner: Session | undefined;
  let pendingReplacement: Replacement | undefined;
  let generation = 0; let closing = false; let closePromise: Promise<void> | undefined;
  const notifyError = (error: Error): void => { try { options.onError(error); } catch { /* Consumer errors must never escape a socket event. */ } };
  const notifyEvent = (event: ProxyEvent): void => { try { options.onEvent?.(event); } catch { notifyError(new Error('Proxy event callback failed')); } };
  function track(socket: Tracked): void { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
  function rejectSocket(socket: Socket, error: Error): void {
    notifyError(error); socket.end(errorResponse(error.message));
    const timer = setTimeout(() => socket.destroy(), 100); timer.unref(); socket.once('close', () => clearTimeout(timer));
  }
  // Name the way forward: a pool that opens several connections needs the lane profile.
  const connectionLimitError = () => new Error(maxConnections === 1
    ? `Unsupported profile: one simultaneous physical connection per actor is supported${multiProducer ? '' : '; for pools or side queries that use several at once, select connectionProfile multi-producer-v1'}`
    : `Unsupported profile: physical connection limit per actor is ${maxConnections}`);
  /**
   * Forward a CancelRequest for one of this actor's own backends, byte for byte,
   * over a fresh upstream connection made with the run's transport policy. The
   * secret key travels only inside the packet and is never retained.
   */
  function routeCancel(packet: Buffer, client: Socket): void {
    const backendPid = packet.readInt32BE(8);
    const target = backendPid > 0 ? [...sessions].find(candidate => candidate.backendPid() === backendPid) : undefined;
    const connection = target?.connection();
    const finish = (): void => {
      client.end();
      const timer = setTimeout(() => client.destroy(), 100); timer.unref(); client.once('close', () => clearTimeout(timer));
    };
    if (!target || connection === undefined) {
      notifyEvent({ type: 'cancel', actor: options.actor, backendPid, forwarded: false });
      finish(); return;
    }
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
    notifyEvent({ type: 'cancel', actor: options.actor, backendPid, connection, forwarded: true, acknowledged });
    const settle = (error?: Error): void => { if (error && !closing) notifyError(error); acknowledge(); finish(); };
    connectPostgresUpstream(transport, { timeoutMs: 5_000 }).then(socket => {
      if (closing) { socket.destroy(); settle(); return; }
      track(socket);
      // PostgreSQL closes the connection once it has signalled the backend. Like libpq,
      // write the packet and take that close as the acknowledgement, orderly or not:
      // on Windows the server's side of the socket is reset rather than ended.
      let timedOut = false;
      socket.once('end', () => socket.end());
      const timer = setTimeout(() => { timedOut = true; socket.destroy(); }, 5_000); timer.unref();
      socket.once('close', () => {
        clearTimeout(timer);
        settle(timedOut ? new Error(`PostgreSQL did not acknowledge the cancel request for backend ${backendPid} within 5 seconds`) : undefined);
      });
      socket.resume(); socket.write(packet);
    }, (error: unknown) => settle(error instanceof UpstreamConnectionError ? error : new Error('Cancel request could not reach PostgreSQL')));
  }
  /** Read a refused connection's first packet: route a CancelRequest, refuse anything else. */
  function refuseUnlessCancel(client: Socket): void {
    let head = Buffer.alloc(0); let negotiations = 0; let settled = false;
    const settle = (packet: Buffer | undefined): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      client.removeListener('data', read); client.removeListener('end', end);
      if (packet) routeCancel(packet, client);
      else rejectSocket(client, connectionLimitError());
    };
    const read = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      while (!settled && head.length >= 8) {
        const length = head.readInt32BE(0); const code = head.readUInt32BE(4);
        // A client that prefers encryption asks first; the actor leg answers no, as for sessions.
        if (length === 8 && (code === 80877103 || code === 80877104) && negotiations < 2) {
          negotiations++; client.write('N'); head = head.subarray(8); continue;
        }
        if (length !== 16 || code !== 80877102) settle(undefined);
        else if (head.length >= 16) settle(head.subarray(0, 16));
        return;
      }
    };
    const end = (): void => settle(undefined);
    const timer = setTimeout(() => settle(undefined), 1_000); timer.unref();
    client.on('data', read); client.once('end', end);
    client.once('close', () => { settled = true; clearTimeout(timer); });
  }
  const server = net.createServer(client => {
    track(client); client.setNoDelay(true);
    if (closing) { client.destroy(); return; }
    // A driver sends a CancelRequest on its own short connection while its sessions
    // are live, so read a connection's first packet before refusing it.
    if (pendingReplacement) { refuseUnlessCancel(client); return; }
    if (sessions.size < maxConnections) { accept(client); return; }
    // The peer's public close can finish before our two socket close callbacks.
    // Keep one prospective startup unadmitted while a conclusively ending session
    // retires. Its generation and upstream exist only after the original closes.
    const retiring = [...sessions].find(session => session.isTerminating());
    if (!retiring) { refuseUnlessCancel(client); return; }
    const replacement: Replacement = { client, retiring, chunks: [], bytes: 0, detach };
    pendingReplacement = replacement;
    function detach(): void {
      client.removeListener('data', retain); client.removeListener('end', abandon);
      client.removeListener('close', abandon); client.removeListener('error', abandon);
      if (pendingReplacement === replacement) pendingReplacement = undefined;
    }
    function abandon(): void { detach(); replacement.chunks = []; client.destroy(); }
    function retain(chunk: Buffer): void {
      if (chunk.length > maxBuffered - replacement.bytes) {
        detach(); replacement.chunks = [];
        client.pause(); rejectSocket(client, new Error('Protocol pending startup buffered-byte limit exceeded'));
        return;
      }
      replacement.bytes += chunk.length;
      if (chunk.length) replacement.chunks.push(chunk);
    }
    // Reading bounded uninterpreted bytes lets FIN be observed even when it
    // follows startup data. A fully paused socket would conceal abandonment.
    client.on('data', retain); client.once('end', abandon);
    client.once('close', abandon); client.once('error', abandon);
  });
  function promoteReplacement(retiring: Session): void {
    const replacement = pendingReplacement;
    if (!replacement || replacement.retiring !== retiring) return;
    const { client } = replacement;
    client.pause(); replacement.detach();
    if (closing || client.destroyed || client.readableEnded || client.writableEnded) { client.destroy(); return; }
    if (sessions.size >= maxConnections) { rejectSocket(client, connectionLimitError()); return; }
    try {
      if (replacement.bytes) client.unshift(Buffer.concat(replacement.chunks, replacement.bytes));
      replacement.chunks = [];
      accept(client); client.resume();
    } catch (error) {
      client.destroy();
      notifyError(error instanceof Error ? error : new Error('Unable to admit replacement actor connection'));
    }
  }
  function accept(client: Socket): void {
    // The generation is assigned at the startup packet, so a socket that never starts,
    // or only carries a CancelRequest, does not take a lane number.
    let connection: number | undefined; let ordinal = 0; let nextCycle = 0; let backendPid = 0; let startupFingerprint = '';
    let cancelling = false;
    let started = false; let ready = false; let negotiated = false; let terminated = false; let failed = false;
    let closed = false; let clientClosed = false; let upstreamClosed = false; let frontendEnded = false; let retainedBytes = 0;
    let pendingTerminate: Buffer | undefined; let saslOffered = false; let saslSelected = false; let authRequests = 0;
    const frontend = new FrameDecoder('startup', options); const backend = new FrameDecoder('typed', options); const assembler = new FrontendAssembler(options); const cycles = new FrontendCycleBuffer(options);
    const upstream = new DeferredUpstream(transport); track(upstream);
    interface Queued { frames: Buffer[]; byteLength: number; ordinal: number; unit?: PendingUnit }
    const queue: Queued[] = [];
    let prefix: { original: FrontendUnit; cycle: number; ordinal: number; complete: boolean; error?: { code: string; message: string } } | undefined;
    interface CopyMeter { direction: 'in' | 'out'; bytes: number; hash: Hash }
    let inFlight: { original: FrontendUnit; summary: BackendSummary | MetadataSummary | FlushSummary; errorSeen: boolean; copies: CopyMeter[]; resolve(value: UnitCompletion): void; reject(error: Error): void } | undefined;
    // COPY FROM STDIN streams the client's copy messages upstream as part of the in-flight
    // unit; `counting` ends when PostgreSQL ends the copy, `ended` when the client does.
    let copyIn: { unit: object; meter: CopyMeter; counting: boolean; ended: boolean } | undefined;
    let copyOut: CopyMeter | undefined;
    function checkRetained(): void {
      const inFlightBytes = inFlight?.original.bytes.length ?? 0;
      const prefixBytes = prefix && prefix.original !== inFlight?.original ? prefix.original.bytes.length : 0;
      if (retainedBytes + cycles.bufferedBytes + frontend.bufferedBytes + inFlightBytes + prefixBytes > maxBuffered) throw new Error('Protocol queued buffered-byte limit exceeded');
    }
    // flush-stages-v1: a cycle whose stages all completed may stay open, as a cursor the
    // application abandons does; PostgreSQL rolls it back when the session ends.
    const openWork = (): boolean => prefix !== undefined && !(flushStages && prefix.complete && !inFlight);
    function shutdown(): void {
      if (closed) return; closed = true;
      const outstanding = Boolean(inFlight || openWork() || queue.length || cycles.bufferedBytes);
      const current = inFlight; inFlight = undefined; current?.reject(new Error('Proxy connection closed before command completion'));
      queue.length = 0; retainedBytes = 0; prefix = undefined;
      // Notify the driver before TCP close, and leave the existing bounded drain
      // window for driver cleanup writes. Nothing received after closed is forwarded.
      if (outstanding && !client.destroyed) client.write(errorResponse('Interleave actor proxy closed before command completion'));
      upstream.destroy();
    }
    let resolveClosed!: () => void;
    const session: Session = { shutdown, closed: new Promise<void>(resolve => { resolveClosed = resolve; }),
      isTerminating: () => !failed && (terminated || frontendEnded || clientClosed),
      backendPid: () => backendPid, connection: () => connection };
    sessions.add(session);
    // One waiter per admitted session, independent of how many prospective
    // replacements abandon their sockets before this session actually retires.
    void session.closed.then(() => { promoteReplacement(session); });
    function fail(error: Error): void {
      if (failed || closed) return; failed = true; notifyError(error);
      const current = inFlight; inFlight = undefined; current?.reject(error);
      queue.length = 0; retainedBytes = 0; prefix = undefined; upstream.destroy();
      client.write(errorResponse(error.message));
      const timer = setTimeout(() => { shutdown(); client.destroy(); }, 100); timer.unref(); client.once('close', () => clearTimeout(timer));
    }
    function guard(work: () => void): void {
      try { work(); } catch (error) { fail(error instanceof Error ? error : new Error('Proxy protocol processing failed')); }
    }
    function write(destination: Tracked, bytes: Buffer, source: Tracked): void {
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
      if (prefix) {
        if (!prefix.complete) return;
        original = flushStages ? proposed.flushContinuation(entry.frames, prefix.original, prefix.error)
          : proposed.continuation(entry.frames, prefix.original, prefix.error);
      } else if (staged && entry.frames.at(-1)![0] === 72) {
        original = flushStages && !FrontendAssembler.isDescribePrefix(entry.frames) ? proposed.flushStage(entry.frames) : proposed.describe(entry.frames);
      } else for (const frame of entry.frames) original = proposed.accept(frame);
      if (!original) throw new Error('Incomplete frontend scheduling unit');
      const retained = original;
      const stage = retained.stage ?? 'complete';
      const cycle = prefix?.cycle ?? nextCycle;
      const prefixOrdinal = prefix?.ordinal;
      const prefixError = prefix?.error;
      if (!startupFingerprint) throw new Error('Actor startup identity was not established');
      let released = false;
      const unit: PendingUnit = {
        actor: options.actor, connection: connection!, ordinal: entry.ordinal, protocol: retained.protocol,
        sql: retained.sql,
        fingerprint: createHash('sha256').update(`interleave-session-v1\0${startupFingerprint}\0${retained.fingerprint}`).digest('hex'), backendPid,
        ...(staged ? { stage, cycle, ...(prefixOrdinal === undefined ? {} : { prefixOrdinal }) } : {}),
        release(): Promise<UnitCompletion> {
          if (released) return Promise.reject(new Error('Scheduling unit already released'));
          if (closed || failed || closing) return Promise.reject(new Error('Proxy connection closed before release'));
          if (!ready || inFlight || queue[0] !== entry) return Promise.reject(new Error('Scheduling units must release in connection order after prior completion'));
          released = true; queue.shift(); retainedBytes -= entry.byteLength;
          if (stage === 'complete' || stage === 'describe' || (stage === 'flush' && !prefix)) nextCycle++;
          // The open cycle remembers its latest stage; the next stage chains to it.
          if (stage === 'describe' || stage === 'flush') prefix = { original: retained, cycle, ordinal: entry.ordinal, complete: false };
          const summary = stage === 'describe' ? new MetadataSummary() : stage === 'flush' ? new FlushSummary(retained.reconciliation) : new BackendSummary(prefixError);
          return new Promise<UnitCompletion>((resolve, reject) => {
            inFlight = { original: retained, summary, errorSeen: Boolean(prefixError), copies: [], resolve, reject };
            guard(() => { checkRetained(); write(upstream, retained.bytes, client); });
          });
        },
      };
      entry.unit = unit;
      try { options.onUnit(unit); } catch { fail(new Error('Proxy scheduling callback failed')); }
    }
    function enqueue(frames: Buffer[]): void {
      const byteLength = frames.reduce((total, frame) => total + frame.length, 0);
      retainedBytes += byteLength;
      checkRetained();
      queue.push({ frames, byteLength, ordinal: ordinal++ });
      announce();
    }
    client.on('data', chunk => guard(() => {
      if (cancelling) return;
      for (const frame of frontend.push(chunk)) {
        if (closed || failed) break;
        if (!started) {
          const version = frame.readUInt32BE(4);
          if (version === 80877103 || version === 80877104) {
            if (frame.length !== 8) throw new Error('Malformed encryption negotiation request');
            negotiated = true; client.write('N'); continue;
          }
          if (version === 80877102) {
            if (frame.length !== 16) throw new Error('Malformed cancellation request');
            // A cancel connection never becomes a session: free its admission slot.
            cancelling = true; sessions.delete(session); upstream.destroy();
            routeCancel(frame, client);
            break;
          }
          if (version !== 196608) throw new Error('Unsupported profile: only PostgreSQL protocol 3.0 is supported');
          const startup = startupParameters(frame); const params = startup.fields;
          if (params.has('replication') && params.get('replication') !== 'false') throw new Error('Unsupported profile: replication');
          if (params.get('database') !== decodeURIComponent(upstreamUrl.pathname.slice(1))) throw new Error('Unsupported profile: actor startup database differs from its assigned database');
          startupFingerprint = startup.fingerprint;
          started = true; connection = generation++;
          notifyEvent({ type: 'startup', actor: options.actor, connection, fingerprint: startupFingerprint });
          write(upstream, frame, client); continue;
        }
        const type = String.fromCharCode(frame[0]!);
        if (terminated) throw new Error('Actor sent protocol data after Terminate');
        if (type === 'p' && !ready) {
          // Answer only a request already forwarded to the actor; pipelined authentication
          // data could otherwise select mechanisms before this proxy can inspect them.
          if (authRequests === 0) throw new Error('Unsupported profile: authentication data sent before the server requested it');
          authRequests--;
          if (saslOffered && !saslSelected) {
            // SASLInitialResponse names its mechanism first. The loopback actor socket
            // has no upstream TLS channel, so a -PLUS binding cannot be passed through.
            saslSelected = true;
            const end = frame.indexOf(0, 5);
            if (end > 5 && frame.toString('latin1', 5, end).endsWith('-PLUS')) throw new Error('Unsupported profile: SCRAM channel binding cannot pass through the plaintext actor connection; disable channel binding for actor clients');
          }
          write(upstream, frame, client); continue;
        }
        if (copyIn) {
          const active = inFlight !== undefined && inFlight === copyIn.unit;
          if ('dcf'.includes(type)) {
            // After PostgreSQL ends a copy it discards further copy messages, as it would directly.
            if (type === 'd') { if (copyIn.counting) { copyIn.meter.bytes += frame.length - 5; copyIn.meter.hash.update(frame.subarray(5)); } }
            else { copyIn.counting = false; copyIn.ended = true; }
            write(upstream, frame, client); continue;
          }
          // A Flush stage completes when PostgreSQL answers its Execute, so the Sync after
          // its CopyDone is the cycle's next release, not part of the stage.
          const flushStage = active && inFlight!.summary instanceof FlushSummary;
          if (active && (type === 'H' || type === 'S') && !(flushStage && type === 'S' && copyIn.ended)) {
            // PostgreSQL ignores Flush and Sync during copy-in. After an extended
            // cycle's CopyDone, the client's Sync is what completes the cycle.
            if (type === 'S' && copyIn.ended) copyIn = undefined;
            write(upstream, frame, client); continue;
          }
          if (active && !copyIn.ended) throw new Error('Unsupported profile: frontend message during COPY FROM STDIN');
          copyIn = undefined;
        }
        if ('dcf'.includes(type)) throw new Error('Unsupported profile: COPY data outside COPY FROM STDIN');
        if (type === 'X') {
          if (frame.length !== 5) throw new Error('Malformed Terminate message');
          if (queue.length || cycles.bufferedBytes || (openWork() && (!inFlight || inFlight.original.stage === 'describe')) || (inFlight && !inFlight.errorSeen)) throw new Error('Actor disconnected with unfinished scheduled work');
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
        if (!multiProducer) {
          if (commandOwner && commandOwner !== session) throw new Error('Unsupported profile: only one live command-producing connection per actor is supported; close the previous command connection before another sends commands, or select the multi-producer-v1 connection profile');
          commandOwner = session;
        }
        const unit = cycles.accept(frame);
        if (unit) enqueue(unit);
        checkRetained();
      }
    }));
    upstream.on('data', chunk => guard(() => {
      for (const frame of backend.push(chunk)) {
        if (closed || failed) break;
        const type = String.fromCharCode(frame[0]!);
        if (type === 'W') throw new Error('Unsupported profile: COPY BOTH is used only by replication');
        if (type === 'G' || type === 'H') {
          if (!inFlight || inFlight.summary instanceof MetadataSummary || copyOut || (copyIn && copyIn.unit === inFlight && !copyIn.ended)) {
            throw new Error('Unsupported profile: COPY response outside a released command');
          }
          const meter: CopyMeter = { direction: type === 'G' ? 'in' : 'out', bytes: 0, hash: createHash('sha256') };
          inFlight.copies.push(meter);
          if (type === 'G') copyIn = { unit: inFlight, meter, counting: true, ended: false }; else copyOut = meter;
        } else if (type === 'd' || type === 'c') {
          if (!copyOut) throw new Error('Unsupported profile: backend COPY data outside COPY TO STDOUT');
          if (type === 'd') { copyOut.bytes += frame.length - 5; copyOut.hash.update(frame.subarray(5)); } else copyOut = undefined;
        } else if (type === 'C' || type === 'E') {
          copyOut = undefined;
          if (copyIn && copyIn.unit === inFlight) copyIn.counting = false;
        }
        if (type === 'K') {
          if (frame.length !== 13) throw new Error('Unsupported backend key format');
          backendPid = frame.readInt32BE(5); // Deliberately never retain or emit the secret key.
        }
        if (type === 'E' && inFlight) inFlight.errorSeen = true;
        if (type === 'R' && !ready && frame.length >= 9) {
          const request = frame.readInt32BE(5);
          // Cleartext, MD5, GSS/SSPI and SASL requests each expect one frontend response.
          if ([3, 5, 7, 8, 9, 10, 11].includes(request)) authRequests++;
          if (request === 10) { saslOffered = true; saslSelected = false; }
        }
        if (type === 'Z' && !ready) {
          if (!backendPid) throw new Error('Backend did not provide its process identity');
          ready = true; notifyEvent({ type: 'connected', actor: options.actor, connection: connection!, backendPid });
          write(client, frame, upstream); announce(); continue;
        }
        if (inFlight) assembler.reconcile(inFlight.original, frame);
        else if (prefix && !['N', 'S', 'A'].includes(type)) throw new Error('Unsupported profile: backend response outside a released stage');
        const completion = inFlight?.summary.accept(frame);
        if (!terminated) write(client, frame, upstream);
        if (completion && inFlight) {
          const current = inFlight; inFlight = undefined;
          const copies = current.copies.length ? current.copies.map(({ direction, bytes, hash }) => ({ direction, bytes, sha256: hash.digest('hex') })) : undefined;
          if (completion.kind === 'metadata') {
            if (!prefix) throw new Error('Missing open metadata cycle');
            prefix.complete = true;
            if (completion.result === 'error') prefix.error = completion.error;
          } else if (completion.kind === 'flush') {
            if (!prefix) throw new Error('Missing open Flush cycle');
            prefix.complete = true;
            if (completion.error) prefix.error = completion.error;
            if (copies) completion.copy = copies;
          } else {
            prefix = undefined;
            if (staged) completion.kind = 'ready';
            if (copies) completion.copy = copies;
          }
          current.resolve(completion);
          if (pendingTerminate) { const frame = pendingTerminate; pendingTerminate = undefined; upstream.end(frame); }
          else announce();
        }
      }
    }));
    client.on('error', () => { if (!closing && !terminated && !failed && !cancelling) fail(new Error('Actor client connection failed')); });
    upstream.on('error', (error: Error) => { if (!closing && !failed && (!terminated || inFlight)) fail(error instanceof UpstreamConnectionError ? error : new Error('PostgreSQL upstream connection failed')); });
    client.on('end', () => {
      if (closing || failed || closed || cancelling) return;
      if (negotiated && !started) fail(new Error('Unsupported profile: TLS/GSS encryption required; configure this local actor connection with ssl:false'));
      else if (!terminated && (inFlight || openWork() || queue.length || cycles.bufferedBytes || frontend.bufferedBytes)) fail(new Error('Actor disconnected with unfinished scheduled work'));
      else if (pendingTerminate) return;
      else { frontendEnded = true; upstream.end(); }
    });
    upstream.on('end', () => {
      if (closed || cancelling) return;
      if (!closing && !failed && (inFlight || openWork() || queue.length || (!terminated && ready))) fail(new Error('PostgreSQL upstream disconnected unexpectedly'));
      else client.end();
    });
    function finishClose(): void {
      if (!clientClosed || !upstreamClosed) return;
      closed = true;
      sessions.delete(session);
      if (commandOwner === session) commandOwner = undefined;
      if (connection !== undefined) notifyEvent({ type: 'disconnected', actor: options.actor, connection });
      resolveClosed();
    }
    client.on('close', () => {
      clientClosed = true;
      if (!closing && !failed && !terminated && !closed && (inFlight || openWork() || queue.length || cycles.bufferedBytes)) fail(new Error('Actor disconnected with unfinished scheduled work'));
      if (!pendingTerminate) upstream.destroy();
      finishClose();
    });
    upstream.on('close', () => {
      upstreamClosed = true;
      if (!closed && !closing && !failed && (inFlight || openWork())) fail(new Error('PostgreSQL upstream disconnected unexpectedly'));
      if (!closed && !client.writableEnded && !failed && !cancelling) client.destroy();
      finishClose();
    });
  }
  await new Promise<void>((resolve, reject) => {
    const onError = () => reject(new Error('Unable to listen on loopback for actor proxy'));
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve(); });
  });
  server.on('error', () => notifyError(new Error('Actor proxy listener failed')));
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Actor proxy did not bind a TCP endpoint'); }
  const endpoint = new URL(transport.connectionString); endpoint.hostname = '127.0.0.1'; endpoint.port = String(address.port);
  // The actor leg is loopback plaintext: no route or upstream TLS setting may escape to it,
  // and an explicit selection keeps ambient PGSSLMODE from requesting TLS here.
  for (const field of ['host', 'hostaddr', 'port', 'sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']) endpoint.searchParams.delete(field);
  endpoint.searchParams.set('sslmode', 'disable');
  return { connectionString: endpoint.toString(), close(): Promise<void> {
    if (closePromise) return closePromise; closing = true;
    if (pendingReplacement) {
      const replacement = pendingReplacement; replacement.detach();
      replacement.chunks = []; replacement.client.destroy();
    }
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
