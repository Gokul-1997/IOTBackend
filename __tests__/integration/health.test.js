const request = require('supertest');
const express = require('express');

describe('GET /health', () => {
  test('returns { ok: true }', async () => {
    const app = express();
    app.get('/health', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
