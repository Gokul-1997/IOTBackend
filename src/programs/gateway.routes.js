const router = require('express').Router();
const {
  rateLimit,
  ipKeyGenerator
} = require('express-rate-limit');
const auth = require('../middleware/gateway.middleware');
const service = require('./gateway.service');
const uploads = require('./gateway-upload');
const {
  handle,
  download
} = require('./gateway-http');
// Bound unauthenticated work without sharing successful gateway traffic behind
// the plant's public address. These counters are local to each API process.
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  keyGenerator: req => ipKeyGenerator(req.ip),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { status: 'error', code: 'TOO_MANY_FAILURES', message: 'Too many calls with a wrong gateway token. Wait 15 minutes.' }
}), auth, rateLimit({
  windowMs: 60000,
  limit: 600,
  keyGenerator: req => String(req.gateway.id),
  standardHeaders: 'draft-8',
  legacyHeaders: false
}));
router.post('/config', handle(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await service.gatewayConfig(req.gateway, req.body || {}));
}));
router.post('/commands/next', handle(async (req, res) => {
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  req.once('aborted', disconnected);
  res.once('close', disconnected);
  try {
    res.setHeader('Cache-Control', 'no-store');
    const result = await service.claim(req.gateway, req.body || {}, abort.signal);
    if (!res.destroyed) res.json(result);
  } finally {
    req.removeListener('aborted', disconnected);
    res.removeListener('close', disconnected);
  }
}));
router.post('/jobs/:id/file', handle(async (req, res) => {
  const result = await service.jobFile(req.gateway, req.params.id, req.headers['x-command-lease'] || req.body?.lease_token);
  await download(req, res, result.file);
}));
router.post('/jobs/:id/progress', handle(async (req, res) => res.json(await service.progress(req.gateway, req.params.id, req.body || {}))));
router.post('/jobs/:id/result', handle(async (req, res) => res.json(await service.result(req.gateway, req.params.id, req.body || {}))));
router.post('/jobs/:id/capture', handle(async (req, res) => {
  await uploads.parse(req, res);
  res.status(201).json(await service.capture(req.gateway, req.params.id, req.body || {}, req.file));
}));
module.exports = router;
