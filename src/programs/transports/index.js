/**
 * Which protocol a given machine is talked to with.
 *
 * The service layer above calls `transportFor(machine)` and then the same
 * five functions regardless of the answer, so the supervisor OTP gate,
 * the per-machine lock, the audit row and the progress events are written
 * once and work for every controller family.
 *
 * Selection order:
 *   1. machines.transfer_protocol, when the column exists and is set
 *   2. the controller name, so an existing fleet routes correctly with no
 *      data migration
 *   3. FTP, which is what every machine used before FOCAS existed here
 *
 * Falling back to FTP rather than throwing is deliberate: an unrecognised
 * controller keeps the behaviour it had yesterday instead of losing
 * transfer entirely because nobody normalised a free-text field.
 */

const ftp = require('../program.transfer');
const focas = require('./focas');

const TRANSPORTS = { FTP: ftp, FOCAS: focas };

/**
 * Fanuc controllers in the field are recorded with no consistent
 * spelling — the live fleet holds "FANUC oi-MF", "FANUC Oi-MF", "Fanuc
 * 0i-MF", "Fanuc 0i-TF", "Fanuc 31i-B" and bare "FANUC". Matching the
 * maker rather than the model is what makes that survivable.
 */
function protocolFromController(controller) {
  const c = String(controller || '').toLowerCase();
  if (c.includes('fanuc')) return 'FOCAS';
  return 'FTP';
}

/** The protocol name this machine will be reached with. */
function protocolFor(machine) {
  const declared = String(machine?.transfer_protocol || '').toUpperCase();
  if (TRANSPORTS[declared]) return declared;
  return protocolFromController(machine?.controller);
}

/** The transport module for this machine. */
function transportFor(machine) {
  return TRANSPORTS[protocolFor(machine)];
}

module.exports = { transportFor, protocolFor, protocolFromController, TRANSPORTS };
