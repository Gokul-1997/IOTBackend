#!/usr/bin/env node
/**
 * Stand-alone FOCAS check — run this on the Windows PC before touching the app.
 *
 * It uses the same transport the API uses, so a pass here means the real
 * code path works against your controller. Nothing else is involved: no
 * database, no login, no supervisor code, no web server. When something
 * fails you are looking at one layer instead of six.
 *
 *   set FOCAS_LIB_PATH=C:\fanuc_test\fwlib64.dll
 *   node scripts/focas-test.js --ip 192.168.1.1                 (connect only)
 *   node scripts/focas-test.js --ip 192.168.1.1 --check O1234    (is it there?)
 *   node scripts/focas-test.js --ip 192.168.1.1 --fetch O1234    (read it back)
 *   node scripts/focas-test.js --ip 192.168.1.1 --send C:\fanuc_test\O1224.NC
 *
 * Run the steps in that order. --send is the only one that changes anything
 * on the machine, so it is the last thing you try and it asks first.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* Read Backend/.env the same way the API does, so FOCAS_LIB_PATH is
   configured in one place and this script and the running server cannot
   disagree about where the library is. An environment variable already
   set in the shell still wins — dotenv does not overwrite one. */
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const focas = require('../src/programs/transports/focas');
const P = require('../src/programs/transports/focas.protocol');

/* ── arguments ── */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const ip = args.ip;
const port = Number(args.port) || P.DEFAULT_PORT;

if (!ip) {
  console.error('Usage: node scripts/focas-test.js --ip <controller ip> [--port 8193]');
  console.error('       [--check O1234] [--fetch O1234] [--send <file>] [--yes]');
  process.exit(2);
}

const machine = { id: 0, machine_serial_no: 'TEST', ip_address: ip, focas_port: port };

/* ── output ── */

const ok   = m => console.log(`  \x1b[32mOK\x1b[0m    ${m}`);
const fail = m => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const info = m => console.log(`        ${m}`);

function report(err) {
  fail(err.message);
  // The FOCAS return code is the thing to quote when asking Fanuc or the
  // machine supplier about a refusal, so make it easy to copy.
  if (err.focas) info(`FOCAS code ${err.focas.code} (${err.focas.name}) during ${err.focas.operation}`);
  else if (err.code) info(`code: ${err.code}`);
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a); }));
}

/* ── steps ── */

async function step1_library() {
  console.log('\n1. FOCAS library');
  const target = process.env.FOCAS_LIB_PATH || '(platform default)';
  info(`FOCAS_LIB_PATH = ${target}`);
  info(`platform       = ${process.platform} ${process.arch}`);

  if (!focas.isAvailable()) {
    fail('the library could not be loaded');
    info('Set FOCAS_LIB_PATH to the full path of fwlib64.dll.');
    info('A 64-bit Node needs the 64-bit library — a 32-bit Fwlib32.dll will not load.');
    return false;
  }
  ok('library loaded');
  return true;
}

async function step2_connect() {
  console.log(`\n2. Connect to ${ip}:${port}`);
  try {
    await focas.testMachineConnection(machine);
    ok('handle opened and released');
    return true;
  } catch (err) {
    report(err);
    info('Check: the controller is powered on, the PC is on the same network,');
    info('and the FOCAS/Ethernet option is enabled on this machine.');
    return false;
  }
}

async function step3_check(name) {
  console.log(`\n3. Is ${name} already on the controller?`);
  try {
    const exists = await focas.machineFileExists(machine, name);
    ok(exists ? 'yes — sending it would overwrite' : 'no — the controller does not have it');
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

async function step4_fetch(name) {
  console.log(`\n4. Read ${name} off the controller`);
  try {
    const content = await focas.fetchProgramFromMachine(machine, name, p => {
      process.stdout.write(`\r        ${p.bytes} bytes…`);
    });
    process.stdout.write('\r');
    ok(`read ${content.length} bytes`);

    const out = path.join(process.cwd(), `focas-fetched-${Date.now()}.nc`);
    fs.writeFileSync(out, content);
    info(`saved to ${out}`);
    info('First lines:');
    content.toString('latin1').split('\n').slice(0, 5).forEach(l => info(`  ${l}`));
    return true;
  } catch (err) {
    process.stdout.write('\r');
    report(err);
    return false;
  }
}

async function step5_send(file) {
  console.log(`\n5. Send ${file} to the controller`);

  if (!fs.existsSync(file)) { fail(`no such file: ${file}`); return false; }
  const content = fs.readFileSync(file);
  info(`${content.length} bytes on disk`);

  const shaped = P.toFanucFormat(content);
  info(`${shaped.length} bytes after adding the leading LF and trailing %`);

  if (!args.yes) {
    console.log('');
    info('This WRITES to the machine. The controller will refuse if a program');
    info('is running, but use an idle machine and a throwaway program number.');
    const answer = await ask('        Type "send" to continue: ');
    if (answer.trim().toLowerCase() !== 'send') { info('cancelled'); return false; }
  }

  try {
    const started = Date.now();
    await focas.sendProgramToMachine(machine, content, path.basename(file), p => {
      const pct = Math.round((p.bytes / p.total) * 100);
      process.stdout.write(`\r        ${pct}%  (${p.bytes}/${p.total} bytes)`);
    });
    process.stdout.write('\r');
    ok(`sent in ${Date.now() - started} ms`);
    info('Now check the program list on the machine panel — that is the real proof.');
    return true;
  } catch (err) {
    process.stdout.write('\r');
    report(err);
    return false;
  }
}

/* ── run ── */

(async () => {
  console.log('─'.repeat(60));
  console.log('FOCAS connection test');
  console.log('─'.repeat(60));

  if (!await step1_library()) process.exit(1);
  if (!await step2_connect()) process.exit(1);

  let allOk = true;
  if (args.check) allOk = await step3_check(args.check) && allOk;
  if (args.fetch) allOk = await step4_fetch(args.fetch) && allOk;
  if (args.send)  allOk = await step5_send(args.send)   && allOk;

  console.log('\n' + '─'.repeat(60));
  console.log(allOk ? 'Done.' : 'Finished with failures — see above.');
  console.log('─'.repeat(60) + '\n');
  process.exit(allOk ? 0 : 1);
})().catch(err => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
