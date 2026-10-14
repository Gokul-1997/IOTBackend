const placements = require('./machine-placement');

async function startListening(server, db, port) {
  await placements.load(db);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.removeListener('error', reject); resolve(); });
  });
}

module.exports = { startListening };
