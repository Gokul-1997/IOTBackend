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

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

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

app.use('/auth', authLimiter);

require('./routes')(app);

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use(require('./middleware/error.middleware'));

module.exports = app;