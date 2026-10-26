'use strict';
const router = require('express').Router();
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const svc = require('./authority.service');
const auth = require('../middleware/auth.middleware');
const owner = require('../middleware/snt.middleware');

router.use((_req, res, next) => {
  if (!config.enabled() || config.mode() !== 'cloud') return res.status(404).json({ message: 'Route not found' });
  res.set('Cache-Control', 'no-store'); next();
});
router.post('/lease', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }), async (req, res, next) => {
  try {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    res.json(await svc.lease(req.body || {}, bearer?.[1]));
  } catch (error) { next(error); }
});
router.use(auth, owner);
router.get('/capabilities', (_req, res) => res.json({ enabled: true, authority: true }));
router.get('/', async (_req, res, next) => { try { res.json(await svc.list()); } catch (error) { next(error); } });
router.post('/', async (req, res, next) => { try { res.status(201).json(await svc.create(req.body || {}, req.user.id)); } catch (error) { next(error); } });
router.put('/:id', async (req, res, next) => { try { res.json(await svc.update(req.params.id, req.body || {}, req.user.id)); } catch (error) { next(error); } });
router.post('/:id/rotate-token', async (req, res, next) => { try { res.json(await svc.rotateToken(req.params.id, req.user.id)); } catch (error) { next(error); } });
router.get('/:id/history', async (req, res, next) => { try { res.json(await svc.history(req.params.id)); } catch (error) { next(error); } });
module.exports = router;
