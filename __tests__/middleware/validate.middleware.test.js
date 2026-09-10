/*
 * Unit tests for validate.middleware.js
 *
 * Covers every rule the middleware supports:
 *  required, type:string (minLength, maxLength, email, time, time_hms),
 *  type:number (min, max), type:array (minItems), type:boolean
 *
 * Tests use direct middleware invocation — no Express app needed.
 */

const validate = require('../../src/middleware/validate.middleware');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    _status: null,
    _body:   null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body  = body;  return this; }
  };
  const next = jest.fn();
  return { req, res, next };
}

function run(schema, body) {
  const { req, res, next } = makeReqRes(body);
  validate(schema)(req, res, next);
  return { res, next };
}

// ─────────────────────────────────────────────────────────────────────────────
// required
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — required', () => {
  test('TC-V-01 passes when required field present', () => {
    const { next } = run({ name: { required: true } }, { name: 'Alice' });
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-02 400 when required field missing', () => {
    const { res, next } = run({ name: { required: true } }, {});
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  test('TC-V-03 400 when required field is empty string', () => {
    const { res, next } = run({ name: { required: true } }, { name: '' });
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  test('TC-V-04 400 when required field is null', () => {
    const { res, next } = run({ name: { required: true } }, { name: null });
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
  });

  test('TC-V-05 error message includes label when provided', () => {
    const { res } = run({ email: { required: true, label: 'Email Address' } }, {});
    expect(res._body.errors[0]).toMatch(/Email Address/);
  });

  test('TC-V-06 error message falls back to field name when no label', () => {
    const { res } = run({ email: { required: true } }, {});
    expect(res._body.errors[0]).toMatch(/email/i);
  });

  test('TC-V-07 non-required missing field is silently skipped', () => {
    const { next } = run({ name: {} }, {});
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-08 multiple required fields — collects all errors', () => {
    const { res } = run(
      { email: { required: true }, password: { required: true } },
      {}
    );
    expect(res._body.errors).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// type: string
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — string rules', () => {
  test('TC-V-10 passes string with no extra rules', () => {
    const { next } = run({ name: { required: true } }, { name: 'Alice' });
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-11 400 when string shorter than minLength', () => {
    const { res, next } = run(
      { name: { required: true, minLength: 5 } },
      { name: 'Al' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/at least 5/);
  });

  test('TC-V-12 passes string at exactly minLength', () => {
    const { next } = run(
      { name: { required: true, minLength: 3 } },
      { name: 'Ali' }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-13 400 when string exceeds maxLength', () => {
    const { res, next } = run(
      { name: { required: true, maxLength: 5 } },
      { name: 'Alexander' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/not exceed 5/);
  });

  test('TC-V-14 passes string at exactly maxLength', () => {
    const { next } = run(
      { name: { required: true, maxLength: 5 } },
      { name: 'Alice' }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-15 400 for invalid email format', () => {
    const { res, next } = run(
      { email: { required: true, email: true } },
      { email: 'notanemail' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/valid email/i);
  });

  test('TC-V-16 passes valid email', () => {
    const { next } = run(
      { email: { required: true, email: true } },
      { email: 'user@example.com' }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-17 400 for invalid HH:MM time format', () => {
    const { res, next } = run(
      { start: { required: true, time: true } },
      { start: '8:00' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/HH:MM/);
  });

  test('TC-V-18 passes valid HH:MM time', () => {
    const { next } = run(
      { start: { required: true, time: true } },
      { start: '08:00' }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-19 400 for invalid HH:MM:SS time format', () => {
    const { res, next } = run(
      { cycle: { required: true, time_hms: true } },
      { cycle: '00:01' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/HH:MM:SS/);
  });

  test('TC-V-20 passes valid HH:MM:SS time', () => {
    const { next } = run(
      { cycle: { required: true, time_hms: true } },
      { cycle: '00:01:30' }
    );
    expect(next).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// type: number
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — number rules', () => {
  test('TC-V-30 passes valid number', () => {
    const { next } = run(
      { qty: { required: true, type: 'number' } },
      { qty: 10 }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-31 400 for non-numeric value', () => {
    const { res, next } = run(
      { qty: { required: true, type: 'number' } },
      { qty: 'abc' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/must be a number/);
  });

  test('TC-V-32 400 when number below min', () => {
    const { res, next } = run(
      { qty: { required: true, type: 'number', min: 1 } },
      { qty: 0 }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/at least 1/);
  });

  test('TC-V-33 passes number at exactly min', () => {
    const { next } = run(
      { qty: { required: true, type: 'number', min: 1 } },
      { qty: 1 }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-34 400 when number exceeds max', () => {
    const { res, next } = run(
      { qty: { required: true, type: 'number', max: 100 } },
      { qty: 101 }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/at most 100/);
  });

  test('TC-V-35 passes numeric string (coerced)', () => {
    const { next } = run(
      { qty: { required: true, type: 'number' } },
      { qty: '42' }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-36 400 for negative when min is 0', () => {
    const { res, next } = run(
      { qty: { required: true, type: 'number', min: 0 } },
      { qty: -1 }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/at least 0/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// type: array
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — array rules', () => {
  test('TC-V-40 passes valid array', () => {
    const { next } = run(
      { ids: { required: true, type: 'array' } },
      { ids: [1, 2, 3] }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-41 400 when non-array given', () => {
    const { res, next } = run(
      { ids: { required: true, type: 'array' } },
      { ids: 'not-array' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/must be an array/);
  });

  test('TC-V-42 400 when array below minItems', () => {
    const { res, next } = run(
      { ids: { required: true, type: 'array', minItems: 2 } },
      { ids: [1] }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/at least 2/);
  });

  test('TC-V-43 passes empty array when minItems not set', () => {
    const { next } = run(
      { ids: { required: true, type: 'array' } },
      { ids: [] }
    );
    expect(next).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// type: boolean
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — boolean rules', () => {
  test('TC-V-50 passes true boolean', () => {
    const { next } = run(
      { active: { required: true, type: 'boolean' } },
      { active: true }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-51 passes false boolean', () => {
    const { next } = run(
      { active: { required: true, type: 'boolean' } },
      { active: false }
    );
    expect(next).toHaveBeenCalled();
  });

  test('TC-V-52 400 when string given instead of boolean', () => {
    const { res, next } = run(
      { active: { required: true, type: 'boolean' } },
      { active: 'true' }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/must be a boolean/);
  });

  test('TC-V-53 400 when number 1 given instead of boolean', () => {
    const { res, next } = run(
      { active: { required: true, type: 'boolean' } },
      { active: 1 }
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._body.errors[0]).toMatch(/must be a boolean/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// response shape
// ─────────────────────────────────────────────────────────────────────────────

describe('validate — response shape', () => {
  test('TC-V-60 error response has status:"error" and errors array', () => {
    const { res } = run({ name: { required: true } }, {});
    expect(res._body.status).toBe('error');
    expect(res._body.message).toMatch(/Validation failed/i);
    expect(Array.isArray(res._body.errors)).toBe(true);
  });

  test('TC-V-61 valid body calls next with no arguments', () => {
    const { next } = run({ name: { required: true } }, { name: 'Test' });
    expect(next).toHaveBeenCalledWith();
  });

  test('TC-V-62 multiple fields — all errors collected before responding', () => {
    const { res } = run(
      {
        a: { required: true },
        b: { required: true },
        c: { required: true }
      },
      {}
    );
    expect(res._body.errors).toHaveLength(3);
  });
});
