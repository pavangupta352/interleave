import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tlsTestCommand } from './tls-test-command.mjs';

const day = 86_400_000;
const timestamp = milliseconds => new Date(milliseconds).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '');

// Explicit test tooling: generated private keys never enter a package or fixture archive.
// In-flight certificate commands settle before their exact owned directory is removed.
export async function withTlsTestCertificates(use, { openssl = 'openssl', signal, onDirectory = () => {} } = {}) {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'interleave-tls-certificates-'));
  await chmod(directory, 0o700);
  try {
    onDirectory(directory);
    const configPath = join(directory, 'openssl.cnf');
    const config = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = Interleave temporary test authority
[root]
basicConstraints = critical,CA:true
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[ca]
default_ca = signing
[signing]
dir = .
database = index.txt
new_certs_dir = issued
certificate = ca.crt
private_key = ca.key
serial = serial
default_md = sha256
default_days = 2
policy = names
unique_subject = no
[names]
commonName = supplied
[valid]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
[wrong_name]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:wrong.interleave.invalid
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
`;
    await writeFile(configPath, config, { mode: 0o600 });
    const run = async args => {
      signal?.throwIfAborted();
      let output;
      try {
        output = await tlsTestCommand(openssl, args, { cwd: directory,
          env: { ...process.env, OPENSSL_CONF: configPath }, timeout: 30_000 });
      } catch { throw new Error('OpenSSL certificate fixture command failed. Install OpenSSL 3 and check local filesystem access.'); }
      signal?.throwIfAborted();
      return output.stdout.trim();
    };
    const opensslVersion = await run(['version']);
    if (!/^OpenSSL 3\./.test(opensslVersion)) throw new Error('OpenSSL 3 is required for the explicit TLS certificate tests.');
    await mkdir(join(directory, 'issued'), { mode: 0o700 });
    await writeFile(join(directory, 'index.txt'), '', { mode: 0o600 });
    await writeFile(join(directory, 'serial'), '1000\n', { mode: 0o600 });
    for (const name of ['ca', 'unrelated-ca']) {
      await run(['req', '-new', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '7',
        '-config', configPath, '-extensions', 'root', '-subj', `/CN=Interleave temporary ${name}`,
        '-keyout', `${name}.key`, '-out', `${name}.crt`]);
      await chmod(join(directory, `${name}.key`), 0o600);
    }
    const now = Date.now(), leaves = {};
    const selections = [
      ['valid', 'valid', now - 300_000, now + 2 * day],
      ['wrongName', 'wrong_name', now - 300_000, now + 2 * day],
      ['expired', 'valid', now - 2 * day, now - day],
      ['future', 'valid', now + day, now + 2 * day],
    ];
    for (const [name, extensions, start, end] of selections) {
      await run(['req', '-new', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-config', configPath,
        '-subj', '/CN=Interleave temporary server', '-keyout', `${name}.key`, '-out', `${name}.csr`]);
      await chmod(join(directory, `${name}.key`), 0o600);
      await run(['ca', '-batch', '-notext', '-config', configPath, '-extensions', extensions,
        '-startdate', timestamp(start), '-enddate', timestamp(end), '-in', `${name}.csr`, '-out', `${name}.crt`]);
      leaves[name] = Object.freeze({ cert: await readFile(join(directory, `${name}.crt`), 'utf8'),
        keyPath: join(directory, `${name}.key`), certPath: join(directory, `${name}.crt`) });
    }
    signal?.throwIfAborted();
    return await use(Object.freeze({ directory, opensslVersion, ca: await readFile(join(directory, 'ca.crt'), 'utf8'),
      unrelatedCa: await readFile(join(directory, 'unrelated-ca.crt'), 'utf8'), leaves: Object.freeze(leaves) }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
