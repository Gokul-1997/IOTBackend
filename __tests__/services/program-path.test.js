/*
 * A machine's program path: where its device saves and reads programs.
 */
const { cleanProgramPath, targetFile } = require('../../src/programs/program-path');

describe('cleanProgramPath', () => {
  test.each([
    ['//CNC_MEM/USER/PATH1/', '//CNC_MEM/USER/PATH1/'],     // Fanuc CNC memory
    ['  M01:\\PRG\\USER\\ ', 'M01:\\PRG\\USER\\'],          // a Mitsubishi drive path, trimmed
    ['/home/pi/nc programs', '/home/pi/nc programs'],        // a folder on the device
    ['', null], ['   ', null], [null, null], [undefined, null] // not set
  ])('%j → %j', (input, out) => expect(cleanProgramPath(input)).toBe(out));

  test.each([
    ['//CNC_MEM/../SYSTEM/', /\.\./],
    ['C:\\NC\\..\\Windows', /\.\./],
    ['/nc;rm -rf /', /letters, digits/],
    ['/nc\n/x', /letters, digits/],
    ['/' + 'a'.repeat(255), /255/]
  ])('%j is refused', (bad, msg) => {
    expect(() => cleanProgramPath(bad)).toThrow(msg);
  });
});

describe('targetFile', () => {
  test.each([
    ['//CNC_MEM/USER/PATH1/', 'O1234', '//CNC_MEM/USER/PATH1/O1234'],
    ['//CNC_MEM/USER/PATH1', 'O1234', '//CNC_MEM/USER/PATH1/O1234'],
    ['M01:\\PRG\\USER\\', 'O1234.nc', 'M01:\\PRG\\USER\\O1234.nc'],
    ['D:\\NC', 'O1234.nc', 'D:\\NC\\O1234.nc'],
    [null, 'O1234', null]
  ])('%j + %j → %j', (path, name, out) => expect(targetFile(path, name)).toBe(out));
});
