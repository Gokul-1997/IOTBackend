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

// Body limits to reduce abuse (tune if you send big payloads)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security headers
app.use(helmet({
    contentSecurityPolicy: false,
}));

// Compression (good for JSON responses)
app.use(compression());

// Logging (use "combined" behind proxy, "dev" locally)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS - don’t leave it wide-open in prod unless truly public
const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin) return cb(null, true);

        if (allowedOrigins.length === 0) return cb(null, true); // fallback if not set
        return allowedOrigins.includes(origin)
            ? cb(null, true)
            : cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
}));

// Global rate limit (apply early)
app.use(standardLimiter);

// Health check (for load balancers)
app.get('/health', (req, res) => res.json({ ok: true }));


app.use('/auth', authLimiter);

// Routes
require('./routes')(app);

// 404 handler (must be before error middleware)
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Route not found' });
});

// Central error handler last
app.use(require('./middleware/error.middleware'));

module.exports = app;
