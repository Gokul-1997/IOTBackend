module.exports = (err, req, res, next) => {
  console.error(err);

  const body = {
    status: 'error',
    message: err.message || 'Internal Server Error'
  };

  /* Application errors carry a code the client branches on — RANGE_TOO_LARGE
     offers email delivery, FILE_EXISTS offers overwrite — and without it every
     caller is left matching on message text.

     Gated on err.status, which only deliberately-thrown errors set. A Postgres
     error also has a .code ('23505', '42501'); forwarding those would hand a
     caller a map of the schema and its permissions. */
  if (err.status && err.code) body.code = err.code;
  if (err.status && err.days != null)     body.days     = err.days;
  if (err.status && err.max_days != null) body.max_days = err.max_days;

  res.status(err.status || 500).json(body);
};
