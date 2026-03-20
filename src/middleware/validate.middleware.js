const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Body validation middleware factory.
 *
 * Schema field options:
 *   required   : boolean
 *   type       : 'string' | 'number' | 'array' | 'boolean'
 *   minLength  : number   (string)
 *   maxLength  : number   (string)
 *   email      : boolean  (string – valid email format)
 *   time       : boolean  (string – HH:MM format)
 *   min        : number   (number – inclusive minimum)
 *   max        : number   (number – inclusive maximum)
 *   minItems   : number   (array – minimum element count)
 *   label      : string   (human-readable field name in errors)
 */
const validate = (schema) => (req, res, next) => {
  const errors = [];
  const body = req.body || {};

  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];
    const label = rules.label || field;
    const isEmpty =
      value === undefined || value === null || value === '';

    if (rules.required && isEmpty) {
      errors.push(`${label} is required`);
      continue;
    }

    if (isEmpty) continue;

    /* ── type checks ───────────────────────────────────────── */
    if (rules.type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        errors.push(`${label} must be a number`);
        continue;
      }
      if (rules.min !== undefined && num < rules.min)
        errors.push(`${label} must be at least ${rules.min}`);
      if (rules.max !== undefined && num > rules.max)
        errors.push(`${label} must be at most ${rules.max}`);
      continue;
    }

    if (rules.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`${label} must be an array`);
        continue;
      }
      if (rules.minItems !== undefined && value.length < rules.minItems)
        errors.push(`${label} must contain at least ${rules.minItems} item(s)`);
      continue;
    }

    if (rules.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push(`${label} must be a boolean`);
      }
      continue;
    }

    /* ── string rules ──────────────────────────────────────── */
    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (rules.minLength && trimmed.length < rules.minLength)
        errors.push(`${label} must be at least ${rules.minLength} characters`);

      if (rules.maxLength && trimmed.length > rules.maxLength)
        errors.push(`${label} must not exceed ${rules.maxLength} characters`);

      if (rules.email && !EMAIL_REGEX.test(trimmed))
        errors.push(`${label} must be a valid email address`);

      if (rules.time && !TIME_REGEX.test(trimmed))
        errors.push(`${label} must be in HH:MM format (e.g. 08:00)`);
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors
    });
  }

  next();
};

module.exports = validate;
