const express  = require('express');
const { body } = require('express-validator');
const router   = express.Router();
const User          = require('../models/User');
const ArtistProfile = require('../models/ArtistProfile');
const authMiddleware = require('../middleware/authMiddleware'); // ✅ FIXED: was '../middleware/auth'
const { validate }   = require('../middleware/validate');       // ✅ kept — validate.js is created separately

// ── POST /api/auth/register ──
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('phone')
    .matches(/^[6-9]\d{9}$/)
    .withMessage('Enter a valid 10-digit Indian mobile number'),
  body('password')
    .matches(/^[A-Z](?=.*\d).+$/)
    .withMessage('Password must start with a capital letter and contain at least one number (e.g., Zorvex1)'),
  body('role')
    .optional()
    .isIn(['buyer', 'artist'])
    .withMessage('Role must be buyer or artist')
], validate, async (req, res) => {
  const { name, email, phone, password, role } = req.body;

  try {
    const emailExists = await User.findOne({ email });
    if (emailExists) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.'
      });
    }

    const phoneExists = await User.findOne({ phone });
    if (phoneExists) {
      return res.status(409).json({
        success: false,
        message: 'An account with this phone number already exists.'
      });
    }

    const user = await User.create({ name, email, phone, password, role: role || 'buyer' });

    if (user.role === 'artist') {
      const profile = await ArtistProfile.create({
        user: user._id,
        displayName: user.name,
        availability: 'open'
      });
      user.artistProfile = profile._id;
      await user.save();
    }

    const token = authMiddleware.generateToken(user._id); // ✅ FIXED: called from authMiddleware
    res.status(201).json({
      success: true,
      token,
      user: {
        id:            user._id,
        name:          user.name,
        email:         user.email,
        role:          user.role,
        artistProfile: user.artistProfile
      }
    });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: `This ${field} is already registered.`
      });
    }
    if (err.message && err.message.includes('Password must')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error('[Register Error]', err);
    res.status(500).json({ success: false, message: 'Server error during registration' });
  }
});

// ── POST /api/auth/login ──
router.post('/login', [
  body('email').isEmail().withMessage('Valid email required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required')
], validate, async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }
    if (!user.isActive) {
      return res.status(403).json({ success: false, message: 'Account has been suspended' });
    }
    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = authMiddleware.generateToken(user._id); // ✅ FIXED: called from authMiddleware
    res.json({
      success: true,
      token,
      user: {
        id:            user._id,
        name:          user.name,
        email:         user.email,
        role:          user.role,
        artistProfile: user.artistProfile
      }
    });
  } catch (err) {
    console.error('[Login Error]', err);
    res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// ── GET /api/auth/me ──
router.get('/me', authMiddleware, async (req, res) => { // ✅ FIXED: was `protect` (named import that didn't exist)
  res.json({ success: true, user: req.user });
});

module.exports = router;
