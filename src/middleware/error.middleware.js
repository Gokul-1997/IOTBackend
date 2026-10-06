const crypto = require('crypto');

/*
 * The last stop for every error.
 *
 * An error thrown on purpose carries a status (400, 403, 404 …) and a
 * message meant for the person using the app; it is passed on as it is.
 *
 * Anything else is unexpected — a database error, a bug — and its message
 * is for us, not for the caller: "column x does not exist", a constraint
 * name or a file path is a map of the system. The caller gets a plain
 * message and a reference; the details go to the log under the same
 * reference, so a support call can find them.
 */
module.exports = (err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500;
  const expected = status < 500 && (err.status || err.statusCode);

  if (!expected) {
    const ref = crypto.randomBytes(4).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return next(err);
    return res.status(status >= 500 ? status : 500).json({
      status: 'error',
      message: status === 503 && err.message ? err.message : 'Something went wrong on the server. Please try again.',
      ref
    });
  }

  if (res.headersSent) return next(err);

  const body = {
    status: 'error',
    message: err.message || 'Request failed'
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

  res.status(status).json(body);
};
