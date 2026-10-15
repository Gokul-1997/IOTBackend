// Compatibility entry point for deployments using the former "api" name.
// Keep the supported single-process settings in one canonical configuration.
const { apps } = require('./ecosystem.config');
module.exports = { apps: apps.map(app => ({ ...app, name: 'api' })) };
