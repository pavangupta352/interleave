import { createHash, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { checkServerIdentity, rootCertificates, type ConnectionOptions } from 'node:tls';
import { domainToASCII } from 'node:url';
import type { ClientConfig } from 'pg';
import type { RunTransportIdentity } from './types.js';

/** Verified upstream TLS: certificate chain and URL hostname/IP; `ca` replaces Node's bundled roots. */
export interface UpstreamTlsInput { readonly mode: 'verify-full'; readonly ca?: string }
type TlsIdentity = Readonly<{
  profile: 'tls-verify-full-v1';
  negotiation: 'postgres-sslrequest-v1';
  minVersion: 'TLSv1.2';
  maxVersion: 'TLSv1.3';
  trustSource: 'node-bundled' | 'custom-ca';
  trustFingerprint: string;
  referenceFingerprint: string;
}>;
export type TransportIdentity = Readonly<{ profile: 'plaintext-v1' }> | TlsIdentity;

/** Private, serializable configuration. Only identity is suitable for run metadata. */
export interface ResolvedPostgresTransport {
  readonly version: 1;
  readonly connectionString: string;
  readonly hostname: string;
  readonly port: number;
  readonly caCertificates: readonly string[];
  readonly identity: TransportIdentity;
}

const messages = {
  'invalid-url': 'Use a bounded PostgreSQL URL with an explicit hostname and database.',
  'invalid-url-credentials': 'Percent-encode the user name and password in the PostgreSQL URL (for example %20 for a space, %25 for %, %40 for @).',
  'native-client-unsupported': 'NODE_PG_FORCE_NATIVE selects libpq bindings that ignore Interleave\'s connection settings; unset it for Interleave runs.',
  'unsupported-url-option': 'Unsupported PostgreSQL URL option. Use sslmode=verify-full or explicit upstream TLS with in-memory CA material; specify routing and credentials in the URL authority.',
  'conflicting-tls-options': 'Select upstream TLS through either the URL or structured configuration, not both.',
  'invalid-tls-options': 'Upstream TLS accepts only mode verify-full and optional PEM CA material.',
  'invalid-ca': 'Upstream CA material must contain only valid PEM CA certificates.',
  'ca-too-large': 'Upstream CA material exceeds the certificate count or size limit.',
  'invalid-snapshot': 'Invalid resolved PostgreSQL transport snapshot.',
  'certificate-name-mismatch': 'The upstream certificate does not match the configured PostgreSQL hostname or IP address.',
} as const;
type ErrorCode = keyof typeof messages;
class PostgresTransportError extends TypeError {
  constructor(readonly code: ErrorCode) {
    super(messages[code]);
    this.name = 'PostgresTransportError';
  }
}
function fail(code: ErrorCode): never { throw new PostgresTransportError(code); }
const MAX_URL_BYTES = 16_384;
const MAX_CA_BYTES = 1_048_576;
// Room for provider bundles such as the AWS RDS global CA bundle (100+ certificates).
const MAX_CA_COUNT = 256;
const MAX_SNAPSHOT_CA_BYTES = 2 * MAX_CA_BYTES;
const MAX_BUNDLED_CA_COUNT = 1_024;
const startupOptions = new Set([
  'options', 'application_name', 'fallback_application_name', 'client_encoding',
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'query_timeout',
]);
const databaseAliases = new Set(['database', 'dbname', 'db']);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

function parseUrl(value: string): { url: URL; hostname: string; port: number } {
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_URL_BYTES || /[\s\u0000-\u001f\u007f]/u.test(value)) fail('invalid-url');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || !url.hostname || url.pathname.length < 2) fail('invalid-url');
    for (const component of [url.username, url.password, url.pathname]) {
      if (/[\u0000-\u001f\u007f]/u.test(decodeURIComponent(component))) fail('invalid-url');
    }
    let hostname = url.hostname;
    if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
    else hostname = domainToASCII(hostname).toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.length > 253 || (!isIP(hostname)
      && !hostname.split('.').every(label => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(label)))) fail('invalid-url');
    const port = url.port === '' ? 5432 : Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) fail('invalid-url');
    url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    url.port = String(port);
    if (Buffer.byteLength(url.toString()) > MAX_URL_BYTES) fail('invalid-url');
    return { url, hostname, port };
  } catch { return fail(credentialsNeedEncoding(value) ? 'invalid-url-credentials' : 'invalid-url'); }
}
function credentialsNeedEncoding(value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_URL_BYTES) return false;
  const userinfo = /^postgres(?:ql)?:\/\/(.*)@[^@]*$/is.exec(value)?.[1];
  if (userinfo === undefined) return false;
  if (/\s/u.test(userinfo)) return true;
  try { decodeURIComponent(userinfo); return false; } catch { return true; }
}

function certificates(pem: string, maxBytes: number, maxCount: number): readonly string[] {
  if (Buffer.byteLength(pem) > maxBytes) fail('ca-too-large');
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\r\n\t ]+)-----END CERTIFICATE-----/g)];
  if (blocks.length > maxCount) fail('ca-too-large');
  if (blocks.length === 0 || pem.replace(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\r\n\t ]+)-----END CERTIFICATE-----/g, '').trim() !== '') fail('invalid-ca');
  const canonical = new Map<string, string>();
  for (const match of blocks) {
    try {
      const base64 = match[1]!.replace(/\s/g, '');
      const der = Buffer.from(base64, 'base64');
      if (der.toString('base64') !== base64) fail('invalid-ca');
      const certificate = new X509Certificate(der);
      if (!certificate.ca || !certificate.raw.equals(der)) fail('invalid-ca');
      canonical.set(digest(der), certificate.toString());
    } catch { fail('invalid-ca'); }
  }
  return Object.freeze([...canonical.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, pem]) => pem));
}
let bundledRoots: readonly string[] | undefined;
function bundledCertificates(): readonly string[] {
  // tls.rootCertificates is Node's immutable bundled set, not ambient/system/extra trust.
  return bundledRoots ??= certificates(rootCertificates.join('\n'), MAX_SNAPSHOT_CA_BYTES, MAX_BUNDLED_CA_COUNT);
}
function snapshot(
  parsed: ReturnType<typeof parseUrl>, caCertificates: readonly string[], trustSource?: TlsIdentity['trustSource'],
): ResolvedPostgresTransport {
  const identity: TransportIdentity = trustSource === undefined ? { profile: 'plaintext-v1' } : {
    profile: 'tls-verify-full-v1', negotiation: 'postgres-sslrequest-v1', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', trustSource,
    trustFingerprint: digest(`interleave-ca-set-v1\n${caCertificates.map(pem => digest(new X509Certificate(pem).raw)).join('\n')}`),
    referenceFingerprint: digest(`interleave-reference-v1\n${parsed.hostname}`),
  };
  return Object.freeze({ version: 1, connectionString: parsed.url.toString(), hostname: parsed.hostname, port: parsed.port,
    caCertificates: Object.freeze([...caCertificates]), identity: Object.freeze(identity) });
}

export function resolvePostgresTransport(databaseUrl: string, upstreamTls?: UpstreamTlsInput): ResolvedPostgresTransport {
  const parsed = parseUrl(databaseUrl);
  const parameters = parsed.url.searchParams;
  const seen = new Set<string>();
  for (const [key] of parameters) {
    if (seen.has(key) || (!startupOptions.has(key) && !databaseAliases.has(key) && key !== 'sslmode')) fail('unsupported-url-option');
    seen.add(key);
  }
  for (const key of databaseAliases) parameters.delete(key);
  const mode = parameters.get('sslmode');
  if (mode !== null && mode !== 'disable' && mode !== 'verify-full') fail('unsupported-url-option');
  if (upstreamTls !== undefined && mode !== null) fail('conflicting-tls-options');
  parameters.delete('sslmode');
  if (upstreamTls !== undefined) {
    try {
      if (!plainRecord(upstreamTls) || !exactKeys(upstreamTls, Object.hasOwn(upstreamTls, 'ca') ? ['mode', 'ca'] : ['mode'])
        || upstreamTls.mode !== 'verify-full' || (Object.hasOwn(upstreamTls, 'ca') && typeof upstreamTls.ca !== 'string')) fail('invalid-tls-options');
    } catch { fail('invalid-tls-options'); }
  }
  if (upstreamTls === undefined && mode !== 'verify-full') return snapshot(parsed, []);
  const customCa = upstreamTls?.ca;
  return snapshot(parsed, customCa === undefined ? bundledCertificates() : certificates(customCa, MAX_CA_BYTES, MAX_CA_COUNT),
    customCa === undefined ? 'node-bundled' : 'custom-ca');
}

/** Validate private JSON/IPC data without trusting its claimed policy or digest. */
export function restorePostgresTransport(value: unknown): ResolvedPostgresTransport {
  try {
    if (!plainRecord(value) || !exactKeys(value, ['version', 'connectionString', 'hostname', 'port', 'caCertificates', 'identity'])
      || value.version !== 1 || typeof value.connectionString !== 'string'
      || !Array.isArray(value.caCertificates) || value.caCertificates.length > MAX_BUNDLED_CA_COUNT
      || Reflect.ownKeys(value.caCertificates).length !== value.caCertificates.length + 1
      || !value.caCertificates.every(pem => typeof pem === 'string') || !plainRecord(value.identity)) fail('invalid-snapshot');
    const ca = value.caCertificates as string[];
    const identity = value.identity;
    if (ca.reduce((bytes, pem) => bytes + Buffer.byteLength(pem), 0) > MAX_SNAPSHOT_CA_BYTES) fail('invalid-snapshot');
    const parsed = resolvePostgresTransport(value.connectionString);
    if (parsed.identity.profile !== 'plaintext-v1' || parsed.connectionString !== value.connectionString) fail('invalid-snapshot');
    let expected: ResolvedPostgresTransport;
    if (identity.profile === 'plaintext-v1') expected = parsed;
    else if (identity.profile === 'tls-verify-full-v1' && identity.trustSource === 'node-bundled') {
      expected = snapshot(parseUrl(value.connectionString), bundledCertificates(), 'node-bundled');
    } else if (identity.profile === 'tls-verify-full-v1' && identity.trustSource === 'custom-ca') {
      expected = snapshot(parseUrl(value.connectionString), certificates(ca.join('\n'), MAX_SNAPSHOT_CA_BYTES, MAX_CA_COUNT), 'custom-ca');
    } else return fail('invalid-snapshot');
    if (value.hostname !== expected.hostname || value.port !== expected.port
      || ca.length !== expected.caCertificates.length || ca.some((pem, index) => pem !== expected.caCertificates[index])
      || !exactKeys(identity, Object.keys(expected.identity))
      || Object.entries(expected.identity).some(([key, field]) => identity[key] !== field)) fail('invalid-snapshot');
    return expected;
  } catch { return fail('invalid-snapshot'); }
}

/** Point a snapshot at another database on the same server without re-resolving its trust. */
export function withPostgresDatabase(resolved: ResolvedPostgresTransport, database: string): ResolvedPostgresTransport {
  const validated = restorePostgresTransport(resolved);
  if (typeof database !== 'string' || !database || Buffer.byteLength(database) > 63 || /[\u0000-\u001f\u007f/]/u.test(database)) fail('invalid-url');
  const url = new URL(validated.connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  const identity = validated.identity;
  return snapshot(parseUrl(url.toString()), validated.caCertificates,
    identity.profile === 'plaintext-v1' ? undefined : identity.trustSource);
}

/**
 * Setup/invariant URL with an explicit TLS selection, so ambient PGSSLMODE cannot
 * change it. A URL cannot carry an in-memory CA; use connectionOptions for that.
 */
export function postgresContextUrl(resolved: ResolvedPostgresTransport): string {
  const validated = restorePostgresTransport(resolved);
  const url = new URL(validated.connectionString);
  url.searchParams.set('sslmode', validated.identity.profile === 'plaintext-v1' ? 'disable' : 'verify-full');
  return url.toString();
}

/** The recorded run contract: policy selected and enforced, never raw trust material. */
export function runTransportIdentity(resolved: ResolvedPostgresTransport): RunTransportIdentity {
  return {
    version: 1, frontend: 'loopback-plaintext-v1', authentication: 'passthrough-no-channel-binding-v1',
    upstream: { ...restorePostgresTransport(resolved).identity },
  };
}

function tlsOptions(resolved: ResolvedPostgresTransport): ConnectionOptions | undefined {
  if (resolved.identity.profile === 'plaintext-v1') return undefined;
  return {
    ca: [...resolved.caCertificates], rejectUnauthorized: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3',
    ...(isIP(resolved.hostname) === 0 ? { servername: resolved.hostname } : {}),
    checkServerIdentity(_hostname, certificate) {
      try {
        if (checkServerIdentity(resolved.hostname, certificate) === undefined) return undefined;
      } catch { /* Keep Node's certificate/hostname fields out of diagnostics. */ }
      return new PostgresTransportError('certificate-name-mismatch');
    },
  };
}

/** Construct callbacks locally; no functions or mutable TLS objects cross IPC. */
export function postgresTlsOptions(resolved: ResolvedPostgresTransport): ConnectionOptions | undefined {
  return tlsOptions(restorePostgresTransport(resolved));
}

export function postgresClientConfig(resolved: ResolvedPostgresTransport): ClientConfig {
  // pg's native binding builds a libpq conninfo that drops these TLS options.
  if (process.env.NODE_PG_FORCE_NATIVE !== undefined) fail('native-client-unsupported');
  const validated = restorePostgresTransport(resolved);
  const url = new URL(validated.connectionString);
  // No connectionString merge: pg can replace ssl and retains IPv6 URL brackets.
  // Unspecified credentials intentionally retain existing pg defaults; their
  // consistent parent/worker resolution is a separate integration concern.
  return {
    ...Object.fromEntries(url.searchParams),
    host: validated.hostname, port: validated.port, database: decodeURI(url.pathname.slice(1)),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: tlsOptions(validated) ?? false, sslnegotiation: 'postgres', enableChannelBinding: false,
  };
}
