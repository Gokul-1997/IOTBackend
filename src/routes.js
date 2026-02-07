module.exports = app => {
  app.use('/api/auth', require('./auth/auth.routes'));
  app.use('/api/users', require('./users/user.routes'));
  app.use('/api/roles', require('./roles/role.routes'));

  app.use('/api/machines', require('./machines/machine.routes'));
  app.use('/api/operators', require('./operators/operator.routes'));
  app.use('/api/shifts', require('./shifts/shift.routes'));
  app.use('/api/assignments', require('./assignments/assignment.routes'));

  app.use('/api/telemetry', require('./telemetry/telemetry.routes'));

  app.use('/api/dashboard', require('./dashboard/dashboard.routes'));

  app.use('/api/reports', require('./reports/report.routes'));

  app.use('/api/oee', require('./oee/oee.routes'));

  app.use('/api/ai', require('./ai/ai.routes'));
  app.use('/api/plants', require('./plants/plant.routes'));


};
