const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

app.set('trust proxy', 1);

const { standardLimiter, authLimiter, loginAccountLimiter, passwordLimiter } = require('./middleware/rateLimit.middleware');

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc:    ["'self'", "https:"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// In production: skip all 2xx/3xx requests — only log errors (4xx/5xx).
// Avoids logging the 30s dashboard API polls from every user, which floods logs.
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('short', {
    skip: (req, res) => res.statusCode < 400
  }));
} else {
  app.use(morgan('dev'));
}

const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (allowedOrigins.length === 0) {
      if (process.env.NODE_ENV === 'production') return cb(new Error('CORS_ORIGINS not configured'));
      return cb(null, true);
    }

    return allowedOrigins.includes(origin)
      ? cb(null, true)
      : cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
}));

app.use(standardLimiter);

// liveness: the process answers
app.get('/health', (req, res) => res.json({ ok: true }));

/* readiness: the process can do its job — the database and Redis answer.
   For the load balancer and monitoring; 503 with what is down otherwise. */
app.get('/health/ready', async (req, res) => {
  const db = require('./db');
  const redis = require('./redis');
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const [dbOk, redisOk] = await Promise.all([
    within(db.query('SELECT 1'), 2000).then(() => true, () => false),
    within(redis.ping(), 2000).then(r => r === 'PONG', () => false)
  ]);
  const ok = dbOk && redisOk;
  res.status(ok ? 200 : 503).json({
    ok, db: dbOk, redis: redisOk,
    db_pool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount },
    uptime_sec: Math.floor(process.uptime())
  });
});

// 🌱 Seed permissions and roles on startup
const roleService = require('./roles/role.service');
roleService.seedPagePermissions()
  .then(result => console.log('✅ Permissions seeded:', result))
  .catch(err => console.error('⚠️ Permission seed warning:', err.message));

/* Sign-in and password reset. Mounted on the real paths: this used to be
   app.use('/auth', …) while the routes are under /api/auth, so it never ran. */
app.use('/api/auth/login', authLimiter, loginAccountLimiter);
app.use(['/api/auth/forgot-password', '/api/auth/reset-password'], passwordLimiter);

require('./routes')(app);

// FIX: cron jobs were never imported anywhere — scheduled jobs never ran
require('./cron');

// API Documentation
require('./swagger/swagger')(app);

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use(require('./middleware/error.middleware'));

module.exports = app;