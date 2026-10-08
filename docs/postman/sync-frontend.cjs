#!/usr/bin/env node
// Publish only the blank, reviewed integration artifacts. No environment files are read.
const fs = require('node:fs');
const path = require('node:path');
require('./validate.cjs');
const docs = path.resolve(__dirname, '..');
const target = path.resolve(__dirname, '../../../FrontendIOT/public/integrations');
const files = [
  'postman/CNC_Program_Transfer.postman_collection.json',
  'postman/CNC_Program_Transfer.local.postman_environment.json',
  'PROGRAM_TRANSFER_QUICKSTART.md',
  'PROGRAM_TRANSFER_DEVICE_API.md'
];
for (const file of files) {
  const destination = path.join(target, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(docs, file), destination);
}
console.log(`Published ${files.length} integration downloads to ${target}`);
