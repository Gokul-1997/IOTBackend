/*
 * Unit tests for programs/program.transfer — the FTP layer that actually
 * touches a controller, with basic-ftp mocked.
 *
 * These cover the two places where being wrong is expensive:
 *
 *  1. File names. They arrive from an uploaded file's own metadata or a
 *     request body and end up as an FTP path on a machine tool. "../"
 *     in that string writes outside the program directory.
 *
 *  2. The overwrite probe. Fanuc's embedded FTP server refuses passive
 *     LIST on several models while handling SIZE and STOR normally, so
 *     the guard cannot be built on a directory listing — and when the
 *     controller can answer neither probe, the honest result is "I don't
 *     know", never "the file isn't there".
 */

const mockClient = {
  access:        jest.fn(),
  cd:            jest.fn(),
  size:          jest.fn(),
  list:          jest.fn(),
  uploadFrom:    jest.fn(),
  downloadTo:    jest.fn(),
  trackProgress: jest.fn(),
  close:         jest.fn()
};

jest.mock('basic-ftp', () => ({
  Client: jest.fn(() => mockClient)
}));

const {
  safeFileName, machineFileExists, sendProgramToMachine, listMachineFiles
} = require('../../src/programs/program.transfer');

const machine = {
  ip_address: '192.168.1.101', ftp_port: 21,
  ftp_user: 'cnc', ftp_pass: 'pw', ftp_dir: '/PRG'
};

/** basic-ftp attaches the numeric FTP reply code to the error it throws. */
const ftpError = (code, msg) => Object.assign(new Error(msg), { code });

const NOT_FOUND       = () => ftpError(550, 'File not found');
const NOT_IMPLEMENTED = () => ftpError(502, 'Command not implemented');

beforeEach(() => {
  Object.values(mockClient).forEach(fn => fn.mockReset());
  mockClient.access.mockResolvedValue();
  mockClient.cd.mockResolvedValue();
});

describe('safeFileName', () => {
  test.each([
    ['../../etc/passwd',        'passwd'],
    ['../O1234.nc',             'O1234.nc'],
    ['sub/dir/O5.nc',           'O5.nc'],
    ['C:\\CAM\\jobs\\part.nc',  'part.nc'],
    ['  O9.nc  ',               'O9.nc'],
    ['O1234.nc',                'O1234.nc']
  ])('%s → %s', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  test('strips control characters', () => {
    // NUL truncates the path server-side; CR/LF would split the FTP command
    // line and let a second command be smuggled in after it.
    expect(safeFileName('O1\u0000.nc')).toBe('O1.nc');
    expect(safeFileName('O2\r\nDELE *.nc')).toBe('O2DELE *.nc');
  });

  test.each([[''], ['   '], ['../'], ['.'], ['..'], [null], [undefined]])(
    'rejects %p outright', (bad) => {
      expect(() => safeFileName(bad)).toThrow(
        expect.objectContaining({ code: 'BAD_FILE_NAME', status: 400 })
      );
    }
  );
});

describe('connecting', () => {
  test('a machine with no IP is a configuration error, not a transport one', async () => {
    await expect(sendProgramToMachine({}, Buffer.from('G0'), 'O1.nc'))
      .rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 400 });
    expect(mockClient.access).not.toHaveBeenCalled();
  });

  test('a missing program directory is reported, never created', async () => {
    mockClient.cd.mockRejectedValue(NOT_FOUND());

    await expect(sendProgramToMachine(machine, Buffer.from('G0'), 'O1.nc'))
      .rejects.toMatchObject({ code: 'BAD_DIRECTORY', status: 400 });

    // ensureDir would have made /PRG on the controller and dropped the
    // program somewhere the operator will never think to look
    expect(mockClient.uploadFrom).not.toHaveBeenCalled();
  });
});

describe('sendProgramToMachine', () => {
  test('refuses to send an empty program', async () => {
    await expect(sendProgramToMachine(machine, Buffer.alloc(0), 'O1.nc'))
      .rejects.toMatchObject({ code: 'EMPTY_PROGRAM', status: 400 });
    expect(mockClient.uploadFrom).not.toHaveBeenCalled();
  });

  test('uploads under the sanitised name, not the one it was handed', async () => {
    mockClient.uploadFrom.mockResolvedValue();

    await sendProgramToMachine(machine, Buffer.from('G0 X0'), '../../O1234.nc');

    expect(mockClient.uploadFrom).toHaveBeenCalledWith(expect.anything(), 'O1234.nc');
  });

  test('detaches the progress handler and closes the socket even when the upload fails', async () => {
    mockClient.uploadFrom.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(sendProgramToMachine(machine, Buffer.from('G0'), 'O1.nc', () => {}))
      .rejects.toThrow('ETIMEDOUT');

    expect(mockClient.close).toHaveBeenCalled();
    expect(mockClient.trackProgress).toHaveBeenLastCalledWith();  // detached
  });
});

describe('machineFileExists', () => {
  test('SIZE answering is enough — no listing is attempted', async () => {
    mockClient.size.mockResolvedValue(2048);

    await expect(machineFileExists(machine, 'O1234.nc')).resolves.toBe(true);
    expect(mockClient.list).not.toHaveBeenCalled();
  });

  test('550 from SIZE means the file is genuinely absent', async () => {
    mockClient.size.mockRejectedValue(NOT_FOUND());

    await expect(machineFileExists(machine, 'O1234.nc')).resolves.toBe(false);
    expect(mockClient.list).not.toHaveBeenCalled();
  });

  test('falls back to a listing when SIZE is not implemented', async () => {
    mockClient.size.mockRejectedValue(NOT_IMPLEMENTED());
    mockClient.list.mockResolvedValue([
      { isFile: true, name: 'O0001.nc' },
      { isFile: true, name: 'O1234.NC' }     // controllers upper-case names
    ]);

    await expect(machineFileExists(machine, 'O1234.nc')).resolves.toBe(true);
  });

  test('when the controller supports neither probe it says so', async () => {
    mockClient.size.mockRejectedValue(NOT_IMPLEMENTED());
    mockClient.list.mockRejectedValue(NOT_IMPLEMENTED());

    // Returning false here would quietly turn the overwrite confirmation
    // into a no-op on exactly the controllers least able to answer, and
    // let a transfer replace a running program with nobody asked.
    await expect(machineFileExists(machine, 'O1234.nc'))
      .rejects.toMatchObject({ code: 'EXISTENCE_UNKNOWN', status: 409 });
  });

  test('a dropped connection is not mistaken for a missing file', async () => {
    mockClient.size.mockRejectedValue(new Error('ECONNRESET'));

    await expect(machineFileExists(machine, 'O1234.nc')).rejects.toThrow('ECONNRESET');
  });

  test('closes the connection whichever way the probe goes', async () => {
    mockClient.size.mockRejectedValue(NOT_FOUND());
    await machineFileExists(machine, 'O1.nc');
    expect(mockClient.close).toHaveBeenCalled();
  });
});

describe('listMachineFiles', () => {
  test('an unsupported LIST is reported as a controller limitation', async () => {
    mockClient.list.mockRejectedValue(NOT_IMPLEMENTED());

    await expect(listMachineFiles(machine)).rejects.toMatchObject({
      code: 'LIST_UNSUPPORTED',
      status: 501
    });
  });

  test('directories are filtered out and files sorted by name', async () => {
    mockClient.list.mockResolvedValue([
      { isFile: true,  name: 'O0002.nc', size: 12 },
      { isFile: false, name: 'SUBDIR' },
      { isFile: true,  name: 'O0001.nc', size: 34 }
    ]);

    const files = await listMachineFiles(machine);

    expect(files.map(f => f.name)).toEqual(['O0001.nc', 'O0002.nc']);
  });
});
