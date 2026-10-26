#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function parse(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw Error('Environment files must use KEY=value without shell commands.');
    if (match[1] in values) throw Error(`Duplicate setting: ${match[1]}`);
    if (/[`$\x00-\x1f]/.test(match[2])) throw Error('Use literal values without shell/Compose interpolation; encode URL passwords.');
    values[match[1]] = match[2];
  }
  return values;
}
function protectedFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw Error(`Use an owner-only regular file (chmod 600): ${path.basename(file)}`);
}
function validate(directory) {
  const releaseFile=path.join(directory,'release.env'), apiFile=path.join(directory,'api.env'), collectorFile=path.join(directory,'collector.env');
  for(const file of [releaseFile,apiFile,collectorFile,path.join(directory,'secrets/installation-token')])protectedFile(file);
  const release=parse(fs.readFileSync(releaseFile,'utf8')),api=parse(fs.readFileSync(apiFile,'utf8'));
  const collector=parse(fs.readFileSync(collectorFile,'utf8'));
  for(const key of ['API_IMAGE','WEB_IMAGE','COLLECTOR_IMAGE'])if(!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(release[key]||''))throw Error(`Provide a verified image digest for ${key}.`);
  for(const key of ['SCHEMA_VERIFIED','BACKUP_RESTORE_VERIFIED'])if(release[key]!=='true')throw Error(`${key} must be verified by the owner before installation.`);
  if(api.DEPLOYMENT_MODE!=='on_prem')throw Error('The on-premise API must use DEPLOYMENT_MODE=on_prem.');
  const url=new URL(api.LICENSE_SERVER_URL);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/licensing/lease'))throw Error('Provide the HTTPS licensing endpoint without credentials in the URL.');
  if(!/^[1-9]\d*$/.test(api.LICENSE_COMPANY_ID||'')||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(api.LICENSE_INSTALLATION_ID||''))throw Error('Provide the owner-issued company and installation identifiers.');
  if(!/^mxl_[A-Za-z0-9_-]{43}$/.test(fs.readFileSync(path.join(directory,'secrets/installation-token'),'utf8').trim()))throw Error('Invalid installation credential.');
  const key=fs.readFileSync(path.join(directory,'secrets/license-public-key.pem'),'utf8');
  if(key.includes('PRIVATE KEY')||require('node:crypto').createPublicKey(key).asymmetricKeyType!=='ed25519')throw Error('Ship the Ed25519 public verification key only.');
  for(const key of ['JWT_SECRET','POSTGRESQL_HOST','POSTGRESQL_USER','POSTGRESQL_PASSWORD','POSTGRESQL_DATABASE','CORS_ORIGINS','REDIS_URL'])if(!api[key]||/change-me|example\.com|REPLACE/.test(api[key]))throw Error(`Configure ${key} in the protected API environment.`);
  if(api.JWT_SECRET.length<32||api.DB_SSL!=='true')throw Error('Use a random JWT secret of at least 32 characters and verified database TLS.');
  if(!/^https:\/\//.test(api.CORS_ORIGINS)||api.CORS_ORIGINS.includes('*'))throw Error('Use an exact HTTPS application origin.');
  if(!collector.MQTT_URL?.startsWith('mqtts://')||!collector.MQTT_USER||!collector.MQTT_PASS)throw Error('Configure authenticated MQTT over TLS.');
  if(collector.DB_SSL!=='true')throw Error('The collector database must also use verified TLS.');
  if(collector.REDIS_TLS!=='true')throw Error('The external collector Redis connection must use verified TLS.');
  if(!api.REDIS_URL.startsWith('rediss://'))throw Error('The external API Redis connection must use TLS.');
  const certificate=fs.readFileSync(path.join(directory,'secrets/database-ca.pem'),'utf8');
  if(certificate.includes('PRIVATE KEY'))throw Error('The database CA file must not contain a private key.');
  const ca=new (require('node:crypto').X509Certificate)(certificate);
  if(!ca.ca||new Date(ca.validTo).getTime()<=Date.now())throw Error('Provide an unexpired public database CA certificate.');
  if(api.LICENSE_SIGNING_KEY_FILE)throw Error('An owner signing key must never be installed on a customer server.');
  return {release,api};
}
function run(args=process.argv.slice(2)) {
  const directory=path.resolve(args[0]||'.');const flags=args.slice(1);
  if(flags.some(flag=>!['--start','--enable-phase3'].includes(flag)))throw Error('Unknown installer option.');
  const {release}=validate(directory);
  if(!flags.includes('--start')){console.log('Preflight passed. Validation only; no services started and no feature activated.');return;}
  if(!flags.includes('--enable-phase3')||release.PHASE3_RELEASE_APPROVED!=='true')throw Error('Phase 3 remains disabled. Owner release approval and --enable-phase3 are both required.');
  const result=spawnSync('docker',['compose','--env-file','release.env','-f','compose.yaml','up','-d','--pull','always'],{cwd:directory,stdio:'inherit'});
  if(result.error||result.status!==0)throw Error('Docker Compose did not start successfully. Review the local service logs.');
}
if(require.main===module){try{run();}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={parse,validate,run};
