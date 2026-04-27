/*
 * Build an Express app for integration tests WITHOUT booting the real server.
 * Mounts the route under test, injects auth context, and forwards everything
 * through the standard error middleware so we can assert on real HTTP shapes.
 */

const express = require('express');

function buildApp({ mountPath, router, user }) {
  const app = express();
  app.use(express.json());

  // Inject a fake authenticated user so route handlers don't need real JWT
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }

  app.use(mountPath, router);

  // Generic error handler matching the production shape
  app.use((err, _req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({ success: false, message: err.message || 'error' });
  });

  return app;
}

const fakeUser = (overrides = {}) => ({
  user_id:    1,
  plant_id:   1,
  company_id: 4,
  user_type:  'ADMIN',
  is_snt_super: false,
  roles: ['ADMIN'],
  permissions: ['*'],
  ...overrides
});

module.exports = { buildApp, fakeUser };
