/**
 * routes/users.js
 *
 * Phone verification (OTP) endpoints — Phase 6 of the fix plan.
 * These routes are the technical implementation of the Identity Lock.
 *
 * All routes use `protect` only (NOT adminOnly) because:
 *   - A freshly-registered user has a JWT but phoneVerified = false.
 *   - The protect middleware's phoneVerified gate exempts /api/users/phone/*
 *     so unverified users can reach these endpoints.
 *   - Once phoneVerified = true, the exemption is irrelevant.
 *
 * SMS Provider:
 *   This implementation uses Fast2SMS (popular Indian SMS gateway) via their
 *   REST API. To switch to Twilio, replace the sendSms() function body.
 *   Required env var: FAST2SMS_API_KEY
 *   Fallback: if no SMS env var is set, the OTP is returned in the response
 *   body in development mode ONLY (never in production).
 *
 * Endpoints:
 *   POST /api/users/phone/send-otp     — Send OTP to a phone number
 *   POST /api/users/phone/verify-otp   — Verify OTP and set phoneVerified = true
 *   GET  /api/users/me                 — Get current user's public profile
 *   PUT  /api/users/me                 — Update name or avatar (not role/email)
 */

'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const https   = require('https');
const User    = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const OTP_LENGTH        = 6;
const OTP_EXPIRY_MINS   = 10;
const OTP_SALT_ROUNDS   = 10;    // lower rounds OK — OTPs are short-lived
const OTP_MAX_ATTEMPTS  = 5;
const OTP_COOLDOWN_SECS = 60;    // minimum seconds between OTP sends

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Generate a numeric OTP of OTP_LENGTH digits
// ─────────────────────────────────────────────────────────────────────────────
const generateOtp = () => {
  const min = Math.pow(10, OTP_LENGTH - 1);
  const max = Math.pow(10, OTP_LENGTH) - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Send SMS via Fast2SMS REST API
//
// To switch providers, replace only this function.
// Must return a Promise that resolves on success or rejects with an Error.
//
// @param {string} phone  — 10-digit Indian number (no +91 prefix)
// @param {string} otp    — plaintext OTP to send
// ─────────────────────────────────────────────────────────────────────────────
const sendSms = (phone, otp) => {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FAST2SMS_API_KEY;

    // Development fallback — never send real SMS without a key
    if (!apiKey) {
      if (process.env.NODE_ENV === 'production') {
        return reject(new Error('SMS service not configured. Please contact support.'));
      }
      // In development: log the OTP so the developer can test without SMS credits
      console.warn(`[DEV] OTP for ${phone}: ${otp}`);
      return resolve({ devMode: true });
    }

    const message  = `Your ZorvEx verification code is: ${otp}. Valid for ${OTP_EXPIRY_MINS} minutes. Do not share this code.`;
    const payload  = JSON.stringify({
      route:   'q',          // Quick SMS route (transactional)
      numbers: phone,
      message,
      flash:   0,
    });

    const options = {
      hostname: 'www.fast2sms.com',
      path:     '/dev/bulkV2',
      method:   'POST',
      headers:  {
        'authorization': apiKey,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.return === true) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.message?.[0] || 'SMS sending failed.'));
          }
        } catch {
          reject(new Error('Invalid response from SMS provider.'));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`SMS network error: ${err.message}`)));
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('SMS request timed out.'));
    });

    req.write(payload);
    req.end();
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// All routes below require authentication (protect middleware)
// The protect middleware explicitly exempts /api/users/phone/* from the
// phoneVerified gate, so unverified users can reach these endpoints.
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/phone/send-otp
// Send an OTP to the user's phone number.
//
// Body: { phone: string }   — 10-digit Indian number
//
// Behaviour:
//   1. Validate phone format
//   2. Check 60-second cooldown between sends
//   3. Check lockout (5 failed attempts)
//   4. Generate 6-digit OTP
//   5. Hash the OTP with bcrypt and save to user.phoneOtp
//   6. Send plaintext OTP via SMS
//
// Response:
//   { message: string, expiresIn: number (seconds) }
//   In dev mode with no SMS key: also includes { otp: string }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phone/send-otp', async (req, res, next) => {
  try {
    const { phone } = req.body;

    // ── Validate ──
    if (!phone) {
      return res.status(400).json({ message: 'phone is required.' });
    }

    const cleaned = phone.toString().trim().replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(cleaned)) {
      return res.status(400).json({
        message: 'Enter a valid 10-digit Indian mobile number.',
      });
    }

    // ── Load user with phoneOtp (normally excluded) ──
    const user = await User.findById(req.user._id).select('+phoneOtp');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // ── Check if already verified ──
    if (user.phoneVerified && user.phone === cleaned) {
      return res.json({ message: 'Phone number is already verified.' });
    }

    // ── Cooldown check ──
    if (user.phoneOtp?.lastSentAt) {
      const secondsAgo = (Date.now() - new Date(user.phoneOtp.lastSentAt).getTime()) / 1000;
      if (secondsAgo < OTP_COOLDOWN_SECS) {
        const remaining = Math.ceil(OTP_COOLDOWN_SECS - secondsAgo);
        return res.status(429).json({
          message: `Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before requesting another OTP.`,
          retryAfter: remaining,
        });
      }
    }

    // ── Lockout check ──
    if (user.phoneOtp?.attempts >= OTP_MAX_ATTEMPTS) {
      // Check if their last OTP has expired (expiry = natural lockout reset)
      const isExpired = user.phoneOtp.expiresAt && new Date() > new Date(user.phoneOtp.expiresAt);
      if (!isExpired) {
        return res.status(429).json({
          message: 'Too many failed attempts. Please try again in 10 minutes.',
        });
      }
      // OTP expired — reset attempts so they can try again
      user.phoneOtp.attempts = 0;
    }

    // ── Generate and hash OTP ──
    const plainOtp    = generateOtp();
    const hashedOtp   = await bcrypt.hash(plainOtp, OTP_SALT_ROUNDS);
    const expiresAt   = new Date(Date.now() + OTP_EXPIRY_MINS * 60 * 1000);

    // Update the user's phone number and OTP state
    user.phone        = cleaned;
    user.phoneOtp     = {
      code:       hashedOtp,
      expiresAt,
      attempts:   0,
      lastSentAt: new Date(),
    };
    await user.save();

    // ── Send SMS ──
    let devOtp = null;
    try {
      const smsResult = await sendSms(cleaned, plainOtp);
      if (smsResult.devMode) devOtp = plainOtp;
    } catch (smsErr) {
      // SMS failed — clear the saved OTP so the user can retry
      user.phoneOtp = { code: null, expiresAt: null, attempts: 0, lastSentAt: null };
      await user.save();
      console.error('SMS send failed:', smsErr.message);
      return res.status(503).json({
        message: 'Failed to send OTP. Please try again in a moment.',
      });
    }

    const response = {
      message:   `OTP sent to +91${cleaned}. Valid for ${OTP_EXPIRY_MINS} minutes.`,
      expiresIn: OTP_EXPIRY_MINS * 60,
    };

    // Only include plaintext OTP in development when no SMS key is configured
    if (devOtp && process.env.NODE_ENV !== 'production') {
      response.otp     = devOtp;
      response.devNote = 'OTP included in response because FAST2SMS_API_KEY is not set. Remove in production.';
    }

    return res.json(response);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/users/phone/verify-otp
// Verify the OTP and mark the user's phone as verified.
//
// Body: { phone: string, otp: string }
//
// Behaviour:
//   1. Validate inputs
//   2. Check OTP exists and is not expired
//   3. Check attempts < OTP_MAX_ATTEMPTS
//   4. Compare OTP with bcrypt
//   5. On success: set phoneVerified = true, clear phoneOtp, return fresh user
//   6. On failure: increment attempts, return error
//
// Response (success):
//   { message: string, user: SafeUser }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phone/verify-otp', async (req, res, next) => {
  try {
    const { phone, otp } = req.body;

    if (!phone) return res.status(400).json({ message: 'phone is required.' });
    if (!otp)   return res.status(400).json({ message: 'otp is required.'   });

    const cleaned = phone.toString().trim().replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(cleaned)) {
      return res.status(400).json({ message: 'Enter a valid 10-digit Indian mobile number.' });
    }

    const otpString = otp.toString().trim();
    if (otpString.length !== OTP_LENGTH || !/^\d+$/.test(otpString)) {
      return res.status(400).json({ message: `OTP must be a ${OTP_LENGTH}-digit number.` });
    }

    // Load user with phoneOtp fields (normally excluded)
    const user = await User.findById(req.user._id).select('+phoneOtp');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // ── Already verified ──
    if (user.phoneVerified && user.phone === cleaned) {
      return res.json({ message: 'Phone number is already verified.' });
    }

    // ── Phone mismatch (user changed phone after sending OTP) ──
    if (user.phone !== cleaned) {
      return res.status(400).json({
        message: 'Phone number does not match. Please request a new OTP.',
      });
    }

    // ── Check OTP state ──
    const otpState = user.phoneOtp;

    if (!otpState?.code || !otpState?.expiresAt) {
      return res.status(400).json({
        message: 'No OTP found for this number. Please request a new one.',
      });
    }

    // ── Check expiry ──
    if (new Date() > new Date(otpState.expiresAt)) {
      // Clear expired OTP
      user.clearOtp();
      await user.save();
      return res.status(400).json({
        message: 'OTP has expired. Please request a new one.',
      });
    }

    // ── Check attempts ──
    if (otpState.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({
        message: 'Too many incorrect attempts. Please request a new OTP.',
      });
    }

    // ── Compare OTP ──
    const isMatch = await bcrypt.compare(otpString, otpState.code);

    if (!isMatch) {
      // Increment failed attempts
      user.phoneOtp.attempts = (otpState.attempts || 0) + 1;
      await user.save();

      const attemptsLeft = OTP_MAX_ATTEMPTS - user.phoneOtp.attempts;
      return res.status(400).json({
        message: attemptsLeft > 0
          ? `Incorrect OTP. ${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining.`
          : 'Too many incorrect attempts. Please request a new OTP.',
        attemptsLeft: Math.max(0, attemptsLeft),
      });
    }

    // ── SUCCESS: verify phone and clear OTP state ──
    user.phoneVerified = true;
    user.clearOtp();
    await user.save();

    // Return the safe user object (same shape as auth endpoints)
    const safeUser = User.sanitize(user);

    return res.json({
      message: 'Phone number verified successfully. Welcome to ZorvEx!',
      user:    safeUser,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me
// Returns the current user's profile (fresh from DB, not from JWT cache).
// Used by the frontend after phone verification to refresh the user object.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password -phoneOtp -googleId -firebaseUid')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({ user: User.sanitize(user) });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/users/me
// Update basic profile fields: name and/or avatar.
// Email, role, phone, and verification fields are NOT updatable here.
//
// Body: { name?: string, avatar?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/me', async (req, res, next) => {
  try {
    const { name, avatar } = req.body;
    const updates = {};

    if (name !== undefined) {
      const trimmed = name.toString().trim();
      if (trimmed.length < 2 || trimmed.length > 80) {
        return res.status(400).json({ message: 'Name must be between 2 and 80 characters.' });
      }
      updates.name = trimmed;
    }

    if (avatar !== undefined) {
      updates.avatar = avatar || null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update.' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -phoneOtp -googleId -firebaseUid');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      message: 'Profile updated.',
      user:    User.sanitize(user),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
