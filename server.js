/**
 * ZorvEx — server.js
 * Production-ready Express + MongoDB backend (Unified Version)
 * Hosted on Render
 */

require('dotenv').config();
const express      = require('express');
const mongoose     = require('mongoose');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const morgan       = require('morgan');
const path         = require('path');

const app = express();

// ─── SECURITY & MIDDLEWARE ──────────────────────────────────────────────────────
app.set('trust proxy', 1); // Required on Render

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Set to true with proper config in final prod
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Global rate limit
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, 
  message: { message: 'Too many requests, please try again later.' },
}));

// Serve Static Files
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE CONNECTION ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ ZorvEx Database Connected (Vault Secured)'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// ─── ROUTE REGISTRATIONS (PHASE 10) ─────────────────────────────────────────────

// 1. Authentication (Google/Email)
app.use('/api/auth', require('./routes/auth'));

// 2. Identity Lock & User Management (Phase 6)
// Mounted early so unverified users can still reach OTP verify endpoints
app.use('/api/users', require('./routes/users'));

// 3. Admin Dashboard & Reports (Phase 4)
const adminRoutes = require('./routes/admin');
app.use('/api/admin', adminRoutes); 
// Separated Report submission so non-admins can POST reports
app.use('/api/admin/reports', adminRoutes.reportRouter);

// 4. Artist & Order Logic (Phase 5 Updates)
app.use('/api/artists', require('./routes/artists'));
app.use('/api/orders', require('./routes/orders'));

// 5. Advanced Features (Phase 4)
app.use('/api/chat', require('./routes/chat'));
app.use('/api/reviews', require('./routes/reviews'));

// 6. Terms & Legal
app.use('/api/terms', require('./routes/terms'));

// ─── SPA FALLBACKS ──────────────────────────────────────────────────────────────
app.get('/phone-verify', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'phone-verify.html'));
});

// ─── ERROR HANDLING ─────────────────────────────────────────────────────────────

// 404 for API
app.use('/api/*', (req, res) => {
  res.status(404).json({ message: 'API Endpoint Not Found' });
});

// Global Error Catcher
app.use((err, req, res, next) => {
  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({ message: `${field} is already registered.` });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Session invalid or expired. Please login.' });
  }

  console.error('🔥 Server Error:', err.stack);
  res.status(err.status || 500).json({
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred.' 
      : err.message
  });
});

// ─── SERVER START ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`
  ══════════════════════════════════════════════
   🚀 ZORVEX EMPIRE ENGINE ONLINE
   📍 Port: ${PORT}
   🛡️ Security: Active
   📱 Identity Lock: Configured (Phase 6)
  ══════════════════════════════════════════════
  `);
});
