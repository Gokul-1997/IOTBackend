module.exports = app => {
  app.use('/api/auth', require('./auth/auth.routes'));
  app.use('/api/users', require('./users/user.routes'));
  app.use('/api/roles', require('./roles/role.routes'));

  app.use('/api/machines', require('./machines/machine.routes'));
  app.use('/api/operators', require('./operators/operator.routes'));
  app.use('/api/shifts', require('./shifts/shift.routes'));
  app.use('/api/assignments', require('./assignments/assignment.routes'));

  app.use('/api/dashboard', require('./dashboard/dashboard.routes'));
  app.use('/api/reports', require('./reports/report.routes'));
  app.use('/api/oee', require('./oee/oee.routes'));

  app.use('/api/plants', require('./plants/plant.routes'));
  app.use('/api/upload', require('./upload/upload.routes'));
  app.use('/api/quality', require('./quality/quality.routes'));
  app.use('/api/master', require('./master/master.routes'));
  app.use('/api/lines', require('./line/line.routes'));
  app.use('/api/components', require('./component/component.routes'));
  app.use('/api/jobs',   require('./job/job.routes'));
  app.use('/api/charts', require('./charts/charts.routes'));

};
