import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTlsTestCertificates } from './tls-test-certificates.mjs';
import { tlsTestCommand } from './tls-test-command.mjs';

const label = 'io.interleave.tls-test-owner';
const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Config.Labels "' + label + '")}},"image":{{json .Image}},"requestedImage":{{json .Config.Image}},"state":{{json .State.Status}},"ports":{{json .NetworkSettings.Ports}}}';
const entrypoint = `chown -R postgres:postgres /tmp/interleave-tls
chmod 0700 /tmp/interleave-tls
chmod 0600 /tmp/interleave-tls/server.key
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_min_protocol_version=TLSv1.2 -c ssl_max_protocol_version=TLSv1.3 -c ssl_cert_file=/tmp/interleave-tls/server.crt -c ssl_key_file=/tmp/interleave-tls/server.key -c hba_file=/tmp/interleave-tls/pg_hba.conf -c password_encryption=scram-sha-256 -c log_connections=on -c log_disconnections=on
`;

// Test-only TLS server, independent of Interleave's runtime transport implementation.
// A signal requests cancellation at safe boundaries; in-flight Docker replies are awaited.
export async function withTlsTestServer({ image = 'postgres:16', leaf = 'valid', signal, onEvent = () => {} } = {}, use) {
  if (!['postgres:16', 'postgres:17', 'postgres:18'].includes(image)) throw new Error('Unsupported TLS test image');
  if (!['valid', 'wrongName', 'expired', 'future'].includes(leaf)) throw new Error('Unsupported TLS test certificate');
  const check = () => signal?.throwIfAborted();
  check();
  return withTlsTestCertificates(async certificates => {
    const owner = randomUUID(), name = `interleave-tls-test-${owner}`, password = randomBytes(24).toString('hex');
    let id, imageId, proposed = false, failed = false, failure, result;
    const event = (type, fields = {}) => onEvent({ type, at: new Date().toISOString(), name, ...fields });
    const docker = async (args, timeout = 15_000, extraEnv = {}) => {
      // Detached children also survive a signal delivered to the fixture owner's group.
      // AbortSignal is intentionally not passed to execFile: create may already be accepted.
      return (await tlsTestCommand('docker', args, { timeout,
        env: { ...process.env, ...extraEnv } })).stdout.trim();
    };
    async function inspect(target) {
      let raw;
      try { raw = await docker(['inspect', '--type', 'container', '--format', inspectFormat, target]); }
      catch (error) {
        const absent = /^Error(?: response from daemon)?: No such (?:object|container): (.+)$/i.exec(error.stderr?.trim() ?? '');
        if (absent?.[1] === target) return undefined;
        throw new Error(`Could not inspect exact TLS test server ${name}`);
      }
      let found;
      try { found = JSON.parse(raw); } catch { throw new Error(`Invalid TLS test server identity for ${name}`); }
      if (!found || !/^[a-f0-9]{64}$/.test(found.id ?? '') || found.name !== '/' + name || found.owner !== owner
        || found.requestedImage !== image || !/^sha256:[a-f0-9]{64}$/.test(found.image ?? '')
        || (id && found.id !== id) || (imageId && found.image !== imageId)) {
        throw new Error(`Refusing operation on mismatched TLS test server ${name}`);
      }
      return found;
    }
    async function cleanup() {
      if (!proposed) return;
      const owned = await inspect(id ?? name);
      if (owned) {
        id = owned.id; imageId = owned.image;
        try { await docker(['rm', '--force', '--volumes', id], 30_000); }
        catch { throw new Error(`Could not remove exact owned TLS test server ${name}`); }
      }
      for (const target of [...new Set([name, id].filter(Boolean))]) {
        if (await inspect(target)) throw new Error(`TLS test server remains after removal: ${name}`);
      }
      event('removed', { id: id ?? null, absent: true });
    }
    try {
      const dockerVersion = await docker(['info', '--format', '{{.ServerVersion}}']);
      check();
      const payload = join(certificates.directory, 'server');
      await mkdir(payload, { mode: 0o700 });
      await copyFile(certificates.leaves[leaf].certPath, join(payload, 'server.crt'));
      await copyFile(certificates.leaves[leaf].keyPath, join(payload, 'server.key'));
      await writeFile(join(payload, 'pg_hba.conf'), 'local all all trust\nhostnossl all all all reject\nhostssl all all all scram-sha-256\n', { mode: 0o600 });
      check();
      proposed = true; event('creating', { requestedImage: image, leaf, opensslVersion: certificates.opensslVersion, dockerVersion });
      let reply;
      try {
        reply = await docker(['create', '--pull=missing', '--name', name, '--label', `${label}=${owner}`,
          '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=postgres',
          '--env', 'POSTGRES_DB=postgres', '--entrypoint', '/bin/sh', image, '-ec', entrypoint],
        180_000, { POSTGRES_PASSWORD: password });
      } catch { throw new Error(`Could not create TLS test server ${name}`); }
      if (!/^[a-f0-9]{64}$/.test(reply)) throw new Error(`Invalid create reply for TLS test server ${name}`);
      const created = await inspect(reply);
      if (!created || created.id !== reply) throw new Error(`Created TLS test server is missing or inconsistent: ${name}`);
      id = created.id; imageId = created.image;
      event('created', { id, image: imageId }); check();
      try { await docker(['cp', payload, `${id}:/tmp/interleave-tls`]); }
      catch { throw new Error(`Could not supply certificates to TLS test server ${name}`); }
      check();
      try { await docker(['start', id]); } catch { throw new Error(`Could not start TLS test server ${name}`); }
      const deadline = performance.now() + 90_000;
      let connection, serverVersion;
      while (performance.now() < deadline) {
        check();
        const state = await inspect(id);
        if (!state || !['created', 'running', 'restarting'].includes(state.state)) throw new Error(`TLS test server stopped before readiness: ${name}`);
        if (state.state === 'running') {
          const bindings = state.ports?.['5432/tcp'];
          if (!Array.isArray(bindings) || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1'
            || !/^\d+$/.test(bindings[0]?.HostPort ?? '') || +bindings[0].HostPort < 1 || +bindings[0].HostPort > 65535) {
            throw new Error(`TLS test server has unexpected network bindings: ${name}`);
          }
          const logs = await docker(['logs', '--tail', '200', id]);
          if (logs.split(/\r?\n/).some(line => line.trim() === 'PostgreSQL init process complete; ready for start up.')) {
            try {
              // Local readiness also supports intentionally invalid server certificates.
              // Real verified TCP acceptance is performed independently by the caller.
              const readiness = await docker(['exec', '--user', 'postgres', id, 'psql', '-X', '-A', '-t', '-d', 'postgres', '-c',
                "SELECT current_setting('server_version') || '|' || current_setting('ssl')"], 5000);
              const parts = readiness.split('|');
              if (!parts[0]?.startsWith(image.split(':')[1] + '.') || parts[1] !== 'on') throw new Error('Server version/TLS configuration mismatch');
              serverVersion = parts[0];
              connection = Object.freeze({ host: '127.0.0.1', port: Number(bindings[0].HostPort), user: 'postgres', password, database: 'postgres' });
              break;
            } catch { /* The final server may still be starting after the init marker. */ }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!connection) throw new Error(`TLS test server did not reach readiness: ${name}`);
      check();
      const identity = Object.freeze({ id, name, owner, image: imageId, requestedImage: image, serverVersion, port: connection.port });
      event('ready', { identity, readiness: 'local-control-only', leaf });
      check();
      result = await use(Object.freeze({ connection, certificates, identity }));
    } catch (error) { failed = true; failure = error; }
    try { await cleanup(); }
    catch (error) { throw new Error(`TLS test cleanup incomplete for ${name}: ${error.message}`); }
    if (failed) throw failure;
    return result;
  }, { signal });
}
