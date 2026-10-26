#!/usr/bin/env node
'use strict';
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const roots=['Backend/src','Backend/package.json','Backend/package-lock.json','Backend/scripts/migrate.js','Backend/deploy/phase3',
  'FrontendIOT/src','FrontendIOT/public','FrontendIOT/package.json','FrontendIOT/package-lock.json','FrontendIOT/angular.json','FrontendIOT/tsconfig.json','FrontendIOT/tsconfig.app.json','FrontendIOT/tsconfig.spec.json','FrontendIOT/postcss.config.js','FrontendIOT/tailwind.config.js',
  'pms-backend/src','pms-backend/package.json','pms-backend/package-lock.json',...['app','buffer','db','redis','server','mqtt','health','mqtt-logger'].map(name=>`pms-backend/${name}.js`)];
function allowed(relative) {
  const segments=relative.split('/');const file=segments.at(-1);
  return !segments.some(name=>['.git','node_modules','__tests__','storage','logs','rollback'].includes(name)) && !file.startsWith('.env') && !file.startsWith('.DS_Store') && !/\.(?:map|pem|key|p12|pfx|spec\.ts|test\.[cm]?js)$/.test(file);
}
function prepare(source,destination) {
  source=path.resolve(source);destination=path.resolve(destination);
  if(destination===source||destination.startsWith(source+path.sep))throw Error('Build the release context outside the source workspace.');
  fs.mkdirSync(destination,{mode:0o700});const manifest=[];
  function copy(relative) {
    if(!allowed(relative))return;const file=path.join(source,relative),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw Error(`Symlinks are not allowed in release inputs: ${relative}`);
    if(stat.isDirectory()){for(const name of fs.readdirSync(file))copy(`${relative}/${name}`);return;}
    if(!stat.isFile())throw Error(`Unsupported release input: ${relative}`);
    const data=fs.readFileSync(file),target=path.join(destination,relative);
    if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(data.toString('utf8')))throw Error(`Private key material found in release input: ${relative}`);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);
    manifest.push({path:relative,sha256:crypto.createHash('sha256').update(data).digest('hex')});
  }
  for(const relative of roots)copy(relative);
  fs.writeFileSync(path.join(destination,'context-manifest.json'),JSON.stringify({version:1,files:manifest},null,2));return manifest;
}
if(require.main===module){try{if(process.argv.length!==3)throw Error('Usage: node prepare-context.cjs /new/private/build-context');const rows=prepare(path.resolve(__dirname,'../../..'),process.argv[2]);console.log(`Prepared ${rows.length} allowlisted files. No repository history, secret files, tests or source maps included.`);}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={allowed,prepare};
