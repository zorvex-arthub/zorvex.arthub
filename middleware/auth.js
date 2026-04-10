/**
 * middleware/auth.js
 *
 * protect        — verifies JWT or Firebase token, checks Blacklist,
 *                  enforces phoneVerified Identity Lock, attaches req.user
 * requireRole    — ensures user has one of the allowed roles
 * requirePhone   — standalone gate: rejects if phoneVerified is false
 *                  (used on routes that need extra-explicit enforcement)
 * adminOnly      — [protect, requireRole('admin')]
 * artistOnly     — [protect, requireRole('artist')]
 * buyerOnly      — [protect, requireRole('buyer')]
 *
 * Phase 3 addition (Fix Plan Step 5):
 *   phoneVerified Identity Lock — after blacklist check, any non-admin user
 *   whose phoneVerified === false is rejected with 403 + needsPhoneVerification:true.
 *   Exempt paths (OTP send/verify, auth routes) bypass this gate so users can
 *   complete verification after registration.
 */

'use strict';

const jwt       = require('jsonwebtoken');
const admin     = require('../config/firebase');
const User      = require('../models/User');
const Blacklist = require('../models/Blacklist');

// ─────────────────────────────────────────────────────────────────────────────
// PHONE VERIFICATION EXEMPT PATHS
// These route prefixes bypass the phoneVerified gate so that:
//   1. Newly-registered users can hit the OTP endpoints to verify.
//   2. Auth endpoints (login, register, google) always work.
//   3. Health check never requires auth.
// The check is applied against the full reconstructed path
// (req.baseUrl + req.path) to work regardless of how the router is mounted.
// ─────────────────────────────────────────────────────────────────────────────
const PHONE_VERIFY_EXEMPT_PREFIXES = [
  '/api/auth',           // login, register, google, me, logout
  '/api/users/phone',    // send-otp, verify-otp  (routes/users.js — Phase 6)
  '/health',             // Render keep-alive check
];

const isPhoneVerifyExempt = (req) => {
  const fullPath = (req.baseUrl + req.path).toLowerCase();
  return PHONE_VERIFY_EXEMPT_PREFIXES.some((prefix) =>
    fullPath.startsWith(prefix.toLowerCase())
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Extract Bearer token from Authorization header
// ─────────────────────────────────────────────────────────────────────────────
const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Blacklist check — runs on every protected request
// Checks by userId, email, phone, and IP so a banned user cannot
// re-enter by creating a new account with the same contact details.
// ─────────────────────────────────────────────────────────────────────────────
const checkBlacklist = async (user, req) => {
  // By userId (most direct)
  if (await Blacklist.isUserBlocked(user._id)) return true;
  // By email
  if (await Blacklist.isBlocked('email', user.email)) return true;
  // By phone (if the user has one registered)
  if (user.phone && await Blacklist.isBlocked('phone', user.phone)) return true;
  // By IP
  const ip = req.ip || req.connection?.remoteAddress;
  if (ip && await Blacklist.isBlocked('ip', ip)) return true;
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Resolve a Firebase ID token to a User document.
// Creates or links the User on first sign-in — same logic as routes/auth.js
// Google path, but here so the middleware can handle Firebase tokens on
// any protected route (not just the /google endpoint).
// ─────────────────────────────────────────────────────────────────────────────
const resolveFirebaseUser = async (decoded) => {
  // Try by Firebase UID first (fastest — indexed field)
  let user = await User.findOne({ firebaseUid: decoded.uid });

  if (!user) {
    // Maybe they registered via email first — try to link
    user = await User.findOne({ email: decoded.email });
    if (user) {
      user.firebaseUid  = decoded.uid;
      user.googleId     = decoded.uid;
      user.authProvider = 'google';
      if (!user.avatar && decoded.picture) user.avatar = decoded.picture;
      if (decoded.email_verified && !user.isVerified) user.isVerified = true;
      await user.save();
    } else {
      // Brand-new Google user — create account
      // role is auto-assigned by User pre-save hook (admin if zorvexinfo@gmail.com)
      user = await User.create({
        name:         decoded.name || decoded.email.split('@')[0],
        email:        decoded.email,
        firebaseUid:  decoded.uid,
        googleId:     decoded.uid,
        authProvider: 'google',
        avatar:       decoded.picture || null,
        isVerified:   decoded.email_verified || false,
        // phoneVerified defaults to false — user must complete phone verification
      });
    }
  }

  return user;
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Determine whether a raw JWT token was issued by Firebase
// (vs our own backend). Firebase tokens have a specific issuer claim.
// We decode without verification just to inspect the 'iss' field.
// ─────────────────────────────────────────────────────────────────────────────
const isFirebaseToken = (token) => {
  try {
    const parts   = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    return typeof payload?.iss === 'string' &&
           payload.iss.includes('securetoken.google.com');
  } catch {
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MIDDLEWARE: protect
//
// Flow:
//   1. Extract Bearer token from Authorization header
//   2. Detect token type (Firebase vs local JWT)
//   3. Verify token and resolve User document
//   4. Check isActive flag
//   5. Check Blacklist (userId, email, phone, IP)
//   6. Check phoneVerified (Identity Lock) — exempt for auth/OTP routes
//   7. Attach req.user and call next()
// ─────────────────────────────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({
      message: 'Not authenticated. Please sign in.',
    });
  }

  try {
    let user;

    // ── STEP 2-3: Token type detection and verification ──
    if (isFirebaseToken(token)) {
      // ── FIREBASE TOKEN PATH ──
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(token);
      } catch (fbErr) {
        return res.status(401).json({
          message: 'Firebase session expired. Please sign in again.',
        });
      }
      user = await resolveFirebaseUser(decoded);
    } else {
      // ── LOCAL JWT PATH ──
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (jwtErr) {
        const isExpired = jwtErr.name === 'TokenExpiredError';
        return res.status(401).json({
          message: isExpired
            ? 'Session expired. Please sign in again.'
            : 'Invalid token. Please sign in again.',
        });
      }
      user = await User.findById(decoded.id).select('-password -phoneOtp');
    }

    // ── STEP 4: User not found ──
    if (!user) {
      return res.status(401).json({
        message: 'Account not found. Please sign in again.',
      });
    }

    // ── STEP 5: Account active check ──
    if (!user.isActive) {
      return res.status(403).json({
        message: 'Your account has been deactivated. Please contact support.',
      });
    }

    // ── STEP 6: Blacklist check ──
    const blocked = await checkBlacklist(user, req);
    if (blocked) {
      return res.status(403).json({
        message: 'Access denied. Your account has been restricted.',
      });
    }

    // ── STEP 7: Identity Lock — phoneVerified gate ──
    // Admin is always exempt (phoneVerified is forced true in User pre-save).
    // All other users must have a verified phone before accessing any
    // protected route, EXCEPT the OTP and auth endpoints listed above.
    if (
      user.role !== 'admin' &&
      !user.phoneVerified &&
      !isPhoneVerifyExempt(req)
    ) {
      return res.status(403).json({
        message:                'Phone verification required before accessing the platform.',
        needsPhoneVerification: true,
        redirectTo:             '/phone-verify.html',
      });
    }

    // ── STEP 8: Attach user and proceed ──
    req.user = user;
    next();

  } catch (err) {
    console.error('protect middleware error:', err.message);
    return res.status(401).json({
      message: 'Authentication failed. Please sign in again.',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUARD: requireRole('admin') or requireRole('artist', 'admin')
//
// Always use AFTER protect().
// Accepts multiple roles: requireRole('buyer', 'admin') allows either.
// ─────────────────────────────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({
      message: `Access denied. This action requires the role: ${roles.join(' or ')}.`,
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// STANDALONE PHONE GATE: requirePhone
//
// Use on routes where you want an explicit 403 if the user somehow
// bypasses the main protect() gate (e.g. direct DB session).
// In normal operation, protect() handles this — this is a safety net.
// ─────────────────────────────────────────────────────────────────────────────
const requirePhone = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }
  if (!req.user.phoneVerified && req.user.role !== 'admin') {
    return res.status(403).json({
      message:                'Phone verification required.',
      needsPhoneVerification: true,
      redirectTo:             '/phone-verify.html',
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// CONVENIENCE ARRAYS — use as route middleware arrays
//
//   router.get('/admin/users', ...adminOnly, handler)
//   router.post('/orders',     ...buyerOnly, handler)
// ─────────────────────────────────────────────────────────────────────────────
const adminOnly  = [protect, requireRole('admin')];
const artistOnly = [protect, requireRole('artist')];
const buyerOnly  = [protect, requireRole('buyer')];

module.exports = {
  protect,
  requireRole,
  requirePhone,
  adminOnly,
  artistOnly,
  buyerOnly,
};
