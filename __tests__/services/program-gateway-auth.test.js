const mockDb = {
  query: jest.fn()
};
jest.mock('../../src/db', () => mockDb);
const middleware = require('../../src/middleware/gateway.middleware');
const token = require('../../src/programs/gateway-token').generate().token;
const record = extra => ({
  id: 2,
  company_id: 4,
  plant_id: 8,
  token_version: 1,
  max_concurrency: 2,
  is_active: true,
  company_active: true,
  plant_active: true,
  last_seen_at: new Date(),
  ...extra
});
function response() {
  const res = {
    status: jest.fn(),
    json: jest.fn()
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}
beforeEach(() => jest.clearAllMocks());
test('missing or legacy machine credentials do not query gateway secrets', async () => {
  for (const value of ['', token.replace('mxg_', 'mxd_')]) {
    const res = response();
    await middleware({
      headers: {
        authorization: 'Bearer ' + value
      }
    }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  }
  expect(mockDb.query).not.toHaveBeenCalled();
});
test('unknown and rotated credentials are indistinguishable', async () => {
  mockDb.query.mockResolvedValue({
    rows: []
  });
  const res = response(),
    next = jest.fn();
  await middleware({
    headers: {
      authorization: 'Bearer ' + token
    }
  }, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.json.mock.calls[0][0].code).toBe('GATEWAY_TOKEN_INVALID');
  expect(next).not.toHaveBeenCalled();
});
test.each([{
  company_active: false
}, {
  plant_active: false
}, {
  is_active: false
}])('inactive company, plant or gateway immediately loses access: %j', async disabled => {
  mockDb.query.mockResolvedValue({
    rows: [record(disabled)]
  });
  const res = response(),
    next = jest.fn();
  await middleware({
    headers: {
      authorization: 'Bearer ' + token
    }
  }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
test('a company gateway can have no plant; it exposes only scoped internal identity to handlers', async () => {
  mockDb.query.mockResolvedValue({
    rows: [record({
      plant_id: null,
      plant_active: null
    })]
  });
  const req = {
      headers: {
        authorization: 'Bearer ' + token
      }
    },
    res = response(),
    next = jest.fn();
  await middleware(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(req.gateway).toEqual({
    id: 2,
    company_id: 4,
    plant_id: null,
    token_version: 1,
    max_concurrency: 2
  });
  expect(req.gateway).not.toHaveProperty('token_hash');
  expect(mockDb.query).toHaveBeenCalledTimes(1);
});
test('heartbeat writes are bounded and never persist the plaintext token', async () => {
  mockDb.query.mockResolvedValueOnce({
    rows: [record({
      last_seen_at: null
    })]
  }).mockResolvedValueOnce({
    rowCount: 1
  });
  const req = {
      ip: '127.0.0.1',
      headers: {
        authorization: 'Bearer ' + token,
        'x-agent-version': 'embedded-1.0'
      }
    },
    next = jest.fn();
  await middleware(req, response(), next);
  expect(next).toHaveBeenCalled();
  expect(mockDb.query.mock.calls[1][1]).toEqual([2, '127.0.0.1', 'embedded-1.0']);
  expect(JSON.stringify(mockDb.query.mock.calls)).not.toContain(token);
});
test('authentication database failure returns a retryable error and does not authorize', async () => {
  mockDb.query.mockRejectedValueOnce(new Error('database temporarily unavailable'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {}),
    res = response(),
    next = jest.fn();
  await middleware({
    headers: {
      authorization: 'Bearer ' + token
    }
  }, res, next);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(next).not.toHaveBeenCalled();
  log.mockRestore();
});
