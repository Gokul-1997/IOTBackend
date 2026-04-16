const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
require('dotenv').config();

const app = express();

app.set('trust proxy', 1);

const { standardLimiter, authLimiter } = require('./middleware/rateLimit.middleware');

app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(helmet({ contentSecurityPolicy: false }));
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

    if (allowedOrigins.length === 0) return cb(null, true);

    return allowedOrigins.includes(origin)
      ? cb(null, true)
      : cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true,
}));

app.use(standardLimiter);

app.get('/health', (req, res) => res.json({ ok: true }));

// 🌱 Seed permissions and roles on startup
const roleService = require('./roles/role.service');
roleService.seedPagePermissions()
  .then(result => console.log('✅ Permissions seeded:', result))
  .catch(err => console.error('⚠️ Permission seed warning:', err.message));

app.use('/auth', authLimiter);

require('./routes')(app);

// FIX: cron jobs were never imported anywhere — scheduled jobs never ran
require('./cron');

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use(require('./middleware/error.middleware'));

module.exports = app;