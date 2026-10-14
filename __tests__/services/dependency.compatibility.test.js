const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadNycConfig } = require('@istanbuljs/load-nyc-config');

test('coverage tooling loads actual YAML configuration with the scoped parser upgrade', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iot-coverage-config-'));
  try {
    await fs.writeFile(path.join(directory, 'package.json'), '{"private":true}');
    await fs.writeFile(path.join(directory, '.nycrc.yaml'), [
      'all: true', 'include:', '  - src/**/*.js',
      'exclude:', '  - src/generated/**',
      'extension:', '  - .js', '  - .cjs', 'branches: 80', ''
    ].join('\n'));
    const config = await loadNycConfig({ cwd: directory });
    expect(config.all).toBe(true);
    expect(config.include).toEqual(['src/**/*.js']);
    expect(config.exclude).toEqual(['src/generated/**']);
    expect(config.extension).toEqual(['.js', '.cjs']);
    expect(config.branches).toBe(80);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
