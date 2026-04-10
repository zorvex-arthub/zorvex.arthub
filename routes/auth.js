/**
 * routes/auth.js
 * POST /api/auth/register       — email/password registration
 * POST /api/auth/login          — email/password login
 * POST /api/auth/google         — Firebase Google Sign-In (exchange Firebase token for app JWT)
 * GET  /api/auth/me             — get current user
 * POST /api/auth/logout         — clear session (client-side; server is stateless)
 */

const router    = require('express').Router();
const jwt       = require('jsonwebtoken');
const admin     = require('../config/firebase');
const User      = require('../models/User');
const Blacklist = require('../models/Blacklist');
const { protect } = require('../middleware/auth');

const ADMIN_EMAIL = 'zorvexinfo@gmail.com';
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN || '7d';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Sign JWT
// ─────────────────────────────────────────────────────────────────────────────
const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Sanitize user for client response
// ─────────────────────────────────────────────────────────────────────────────
const sanitizeUser = (user) => ({
  _id:          user._id,
  name:         user.name,
  email:        user.email,
  phone:        user.phone,
  role:         user.role,
  avatar:       user.avatar,
  isVerified:   user.isVerified,
  authProvider: user.authProvider,
  artistProfile: user.artistProfile,
  savedAddresses: user.savedAddresses,
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    let { name, email, phone, password, role } = req.body;

    email = email?.toLowerCase().trim();

    // Prevent role escalation
    if (email !== ADMIN_EMAIL) {
      if (role === 'admin') {
        return res.status(403).json({ message: 'You cannot register as admin.' });
      }
      role = role === 'artist' ? 'artist' : 'buyer';
    }

    // Check blacklist before creating account
    if (await Blacklist.isBlocked('email', email)) {
      return res.status(403).json({ message: 'Registration not allowed from this email.' });
    }
    if (phone && await Blacklist.isBlocked('phone', phone)) {
      return res.status(403).json({ message: 'Registration not allowed from this phone number.' });
    }
    const ip = req.ip;
    if (ip && await Blacklist.isBlocked('ip', ip)) {
      return res.status(403).json({ message: 'Registration temporarily restricted from your network.' });
    }

    const user = await User.create({ name, email, phone, password, role });
    const token = signToken(user._id);

    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Your account has been deactivated.' });
    }

    // Blacklist check
    if (await Blacklist.isUserBlocked(user._id)) {
      return res.status(403).json({ message: 'Access denied. Your account has been restricted.' });
    }

    const token = signToken(user._id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
// Frontend sends Firebase ID token → we verify it → return our own JWT
// This lets you use one auth system (JWT) across the entire app.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/google', async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: 'Firebase ID token is required.' });
    }

    // Verify with Firebase Admin
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ message: 'Invalid Firebase token. Please sign in again.' });
    }

    const { uid, email, name, picture, email_verified } = decoded;
    const normalizedEmail = email.toLowerCase().trim();

    // Blacklist check
    if (await Blacklist.isBlocked('email', normalizedEmail)) {
      return res.status(403).json({ message: 'Access denied from this Google account.' });
    }

    // Find by Firebase UID first, then by email
    let user = await User.findOne({ firebaseUid: uid });

    if (!user) {
      user = await User.findOne({ email: normalizedEmail });
      if (user) {
        // Link existing local account → Google
        user.firebaseUid  = uid;
        user.googleId     = uid;
        user.authProvider = 'google';
        if (!user.avatar && picture) user.avatar = picture;
        user.isVerified = email_verified || user.isVerified;
        await user.save();
      } else {
        // New Google user
        user = await User.create({
          name:         name || normalizedEmail.split('@')[0],
          email:        normalizedEmail,
          firebaseUid:  uid,
          googleId:     uid,
          authProvider: 'google',
          avatar:       picture || null,
          isVerified:   email_verified || false,
          // No password for Google users
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'Your account has been deactivated.' });
    }

    const token = signToken(user._id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ user: sanitizeUser(user) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout  (stateless — just a signal for client cleanup)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully.' });
});

module.exports = router;
