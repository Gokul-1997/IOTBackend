#!/usr/bin/env node
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
// Owner-run only. Nothing calls this during application boot or installation.
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw Error('Usage: node keygen.cjs /owner-only/new-key-directory');
    const directory = path.resolve(process.argv[2]);
    fs.mkdirSync(directory, { mode: 0o700 });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(directory, 'license-private.pem'), privateKey.export({format:'pem',type:'pkcs8'}), {mode:0o600,flag:'wx'});
    fs.writeFileSync(path.join(directory, 'license-public.pem'), publicKey.export({format:'pem',type:'spki'}), {mode:0o644,flag:'wx'});
    console.log('Keys created. Keep license-private.pem only on the owner authority. Distribute only license-public.pem.');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
