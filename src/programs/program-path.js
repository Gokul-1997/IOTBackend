/**
 * A machine's program path: the folder on the machine side where its device
 * saves the programs sent to it and reads programs from for backups — e.g.
 * //CNC_MEM/USER/PATH1/ on a Fanuc, or a folder on the device itself. It is
 * set once on the platform and handed to the device on every call.
 *
 * The device writes to it, so a path must not be able to climb out of itself
 * (..) or carry anything a file system or a controller would take as more
 * than a path.
 */
const ALLOWED = /^[A-Za-z0-9 _\-.:/\\]+$/;

const fail = (message) => Object.assign(new Error(message), { code: 'BAD_PROGRAM_PATH', status: 400 });

/** The path as it is stored: trimmed, checked; empty means "not set" (null). */
function cleanProgramPath(value) {
  if (value === null || value === undefined) return null;
  const p = String(value).trim();
  if (!p) return null;
  if (p.length > 255) throw fail('The program path can be at most 255 characters.');
  if (!ALLOWED.test(p)) throw fail('The program path can hold letters, digits, spaces and _ - . : / \\ only.');
  if (p.split(/[\\/]+/).some(seg => seg === '..')) throw fail('The program path cannot contain "..".');
  return p;
}

/** The program's full name on the machine: the folder, then the program, with the folder's own separator. */
function targetFile(path, programName) {
  if (!path) return null;
  if (/[\\/]$/.test(path)) return path + programName;
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  return path + sep + programName;
}

module.exports = { cleanProgramPath, targetFile };
