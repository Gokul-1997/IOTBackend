module.exports = app => {
  // ── Core Auth & Users ──────────────────────────────────────────
  app.use('/api/auth',         require('./auth/auth.routes'));
  app.use('/api/auth/2fa',     require('./auth/twofa.routes'));
  app.use('/api/users',        require('./users/user.routes'));
  app.use('/api/roles',        require('./roles/role.routes'));
  app.use('/api/companies',    require('./companies/company.routes'));
  app.use('/api/plans',        require('./plans/plan.routes'));

  // ── Plant & Machine Setup ──────────────────────────────────────
  app.use('/api/machines',     require('./machines/machine.routes'));
  app.use('/api/operators',    require('./operators/operator.routes'));
  app.use('/api/shifts',       require('./shifts/shift.routes'));
  app.use('/api/assignments',  require('./assignments/assignment.routes'));
  app.use('/api/plants',       require('./plants/plant.routes'));
  app.use('/api/lines',        require('./line/line.routes'));
  app.use('/api/components',   require('./component/component.routes'));
  app.use('/api/jobs',         require('./job/job.routes'));
  app.use('/api/master',       require('./master/master.routes'));

  // ── Dashboard & Analytics ──────────────────────────────────────
  app.use('/api/dashboard',    require('./dashboard/dashboard.routes'));
  app.use('/api/oee',          require('./oee/oee.routes'));
  app.use('/api/charts',       require('./charts/charts.routes'));
  app.use('/api/quality',      require('./quality/quality.routes'));

  // ── Reports & Exports ─────────────────────────────────────────
  app.use('/api/reports',              require('./reports/report.routes'));
  app.use('/api/reports/pdf',          require('./reports/pdf.routes'));
  app.use('/api/reports/operator',     require('./reports/operator.report.routes'));

  // ── New Features ──────────────────────────────────────────────
  app.use('/api/alarms',           require('./alarms/alarm.routes'));
  app.use('/api/notifications',    require('./notifications/notification.routes'));
  app.use('/api/audit',            require('./audit/audit.routes'));
  app.use('/api/downtime',         require('./downtime/downtime.routes'));
  app.use('/api/maintenance',      require('./maintenance/maintenance.routes'));
  app.use('/api/production-plans', require('./production-plans/plan.routes'));

  // ── File Upload ───────────────────────────────────────────────
  app.use('/api/upload',       require('./upload/upload.routes'));
};
