import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);

// Codex accepts an extra CA from CODEX_CA_CERTIFICATE but rejects a self-signed
// leaf. Create a short-lived CA, sign one localhost leaf, then delete the CA key
// so nothing else can be signed with it. Node has no X.509 writer, so use openssl.
export async function createLocalCertificates(dir, { openssl = 'openssl' } = {}) {
  const file = name => join(dir, name);
  const caKey = file('ca-key.pem');
  writeFileSync(file('leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 });
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  try {
    await run(openssl, ['req', '-x509', ...ec, '-keyout', caKey, '-out', file('ca.pem'), '-days', '2', '-subj', '/CN=codex-claude-bridge local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign']);
    await run(openssl, ['req', '-new', ...ec, '-keyout', file('leaf-key.pem'), '-out', file('leaf.csr'), '-subj', '/CN=localhost']);
    await run(openssl, ['x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.pem'), '-CAkey', caKey, '-CAcreateserial',
      '-out', file('leaf.pem'), '-days', '2', '-extfile', file('leaf.ext')]);
  } finally {
    for (const name of [caKey, file('leaf.csr'), file('leaf.ext'), file('ca.srl')]) { try { unlinkSync(name); } catch {} }
  }
  return { ca: file('ca.pem'), key: file('leaf-key.pem'), cert: file('leaf.pem') };
}
