const service = require('./program.service');

exports.createProgram = async (req, res) => {
  try {
    const data = await service.createProgram(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
};

exports.getPrograms = async (req, res) => {
  try {
    const result = await service.getPrograms(req);
    res.json({ status: 'success', data: result.data, total: result.total });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};

exports.downloadProgram = async (req, res) => {
  try {
    const file = await service.getProgramFile(req);
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(file.content);
  } catch (e) {
    res.status(404).json({ status: 'error', message: e.message });
  }
};

exports.deleteProgram = async (req, res) => {
  try {
    await service.deleteProgram(req);
    res.json({ status: 'success', message: 'Program deleted successfully' });
  } catch (e) {
    res.status(e.status || 400).json({ status: 'error', code: e.code, message: e.message });
  }
};

exports.transferProgram = async (req, res) => {
  try {
    const data = await service.transferProgram(req);
    res.json({ status: 'success', data, message: 'Program transferred to machine' });
  } catch (e) {
    // 409 carries a code so the UI can offer "overwrite?" instead of a plain error
    res.status(e.status || 400).json({ status: 'error', code: e.code, message: e.message });
  }
};

exports.transferBatch = async (req, res) => {
  try {
    const data = await service.transferBatch(req);
    res.json({
      status: 'success',
      data,
      message: `${data.succeeded} of ${data.total} transfers completed`
    });
  } catch (e) {
    res.status(e.status || 400).json({ status: 'error', code: e.code, message: e.message });
  }
};

exports.listMachinePrograms = async (req, res) => {
  try {
    const data = await service.listMachinePrograms(req);
    res.json({ status: 'success', data, total: data.length });
  } catch (e) {
    res.status(e.status || 502).json({ status: 'error', message: e.message });
  }
};

exports.fetchFromMachine = async (req, res) => {
  try {
    const data = await service.fetchFromMachine(req);
    res.json({ status: 'success', data, message: 'Program retrieved from machine' });
  } catch (e) {
    res.status(e.status || 400).json({ status: 'error', code: e.code, message: e.message });
  }
};

exports.getMachineStatus = async (req, res) => {
  try {
    // Reachability is a result, not an error — an offline machine still 200s
    // so the indicator can render "offline" rather than failing the request.
    const data = await service.getMachineStatus(req);
    res.json({ status: 'success', data });
  } catch (e) {
    res.status(e.status || 400).json({ status: 'error', message: e.message });
  }
};

exports.getTransfers = async (req, res) => {
  try {
    const result = await service.getTransfers(req);
    res.json({ status: 'success', data: result.data, total: result.total });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
};

/* Programs read off a machine before an overwrite replaced them. */
exports.getBackups = async (req, res) => {
  try {
    const result = await service.getBackups(req);
    res.json({ status: 'success', data: result.data, total: result.total });
  } catch (e) {
    res.status(e.status || 500).json({ status: 'error', message: e.message, code: e.code });
  }
};

exports.testConnection = async (req, res) => {
  try {
    await service.testConnection(req);
    // Not "FTP connection successful" any more — a Fanuc machine is reached
    // over FOCAS, and reporting the wrong protocol sends whoever is
    // diagnosing a failure to the wrong place.
    res.json({ status: 'success', message: 'Connection to the machine succeeded' });
  } catch (e) {
    res.status(e.status || 502).json({ status: 'error', message: e.message, code: e.code });
  }
};
