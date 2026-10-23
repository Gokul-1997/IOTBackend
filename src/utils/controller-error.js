const errorMiddleware = require('../middleware/error.middleware');

/** Preserve public validation/refusal messages; unexpected errors go through
 * the shared redaction/logging boundary, never straight to the caller. */
module.exports = (error, req, res, shape = {}) => {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return res.status(status).json({ ...shape, message: error.message || 'Request failed' });
  }
  return errorMiddleware(error, req, res, err => res.destroy?.(err));
};
