/**
 * models/User.js
 *
 * Supports both password-based and Firebase Google Auth accounts.
 * Admin is permanently restricted to zorvexinfo@gmail.com only.
 *
 * Phase 2 additions (Fix Plan Step 3):
 *   - phoneVerified: Boolean  — Identity Lock gate (mandatory feature)
 *   - phoneOtp: { code, expiresAt, attempts } — OTP verification state
 *
 * Note: isVerified remains for email/Google email_verified status.
 *       phoneVerified is the separate, dedicated platform access gate.
 */

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_EMAIL      = 'zorvexinfo@gmail.com';
const SALT_ROUNDS      = 12;
const OTP_MAX_ATTEMPTS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// SAVED ADDRESS SUB-SCHEMA
// Buyer convenience: stores last 2 delivery addresses (max enforced by method)
// ─────────────────────────────────────────────────────────────────────────────
const SavedAddressSchema = new mongoose.Schema({
  label:   { type: String, default: 'Home', trim: true },
  name:    { type: String, trim: true },
  phone:   { type: String, trim: true },
  address: { type: String, trim: true },
  city:    { type: String, trim: true },
  state:   { type: String, trim: true },
  pincode: { type: String, trim: true },
}, { _id: false });

// ─────────────────────────────────────────────────────────────────────────────
// OTP SUB-SCHEMA
// Stores the current pending OTP state for phone verification.
// Cleared after successful verification.
// Never returned to clients — always excluded with .select('-phoneOtp').
// ─────────────────────────────────────────────────────────────────────────────
const PhoneOtpSchema = new mongoose.Schema({
  // Bcrypt-hashed OTP — never store plaintext
  code: {
    type:    String,
    default: null,
    select:  false,   // never returned in queries
  },
  expiresAt: {
    type:    Date,
    default: null,
  },
  // Tracks failed attempts — locked out after OTP_MAX_ATTEMPTS
  attempts: {
    type:    Number,
    default: 0,
    min:     0,
    max:     OTP_MAX_ATTEMPTS,
  },
  // ISO string of when the last OTP was sent — used for cooldown enforcement
  lastSentAt: {
    type:    Date,
    default: null,
  },
}, { _id: false });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({

  // ── IDENTITY ──────────────────────────────────────────────────────────────
  name: {
    type:      String,
    required:  [true, 'Name is required'],
    trim:      true,
    minlength: [2, 'Name must be at least 2 characters'],
    maxlength: [80, 'Name cannot exceed 80 characters'],
  },

  email: {
    type:      String,
    required:  [true, 'Email is required'],
    unique:    true,
    lowercase: true,
    trim:      true,
    match:     [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'],
  },

  // ── PHONE ─────────────────────────────────────────────────────────────────
  // Required for all users — enforced at application layer via phone-verify flow.
  // Optional at schema level only to allow Google-auth users who haven't yet
  // added their number (they cannot access the platform until phoneVerified = true).
  phone: {
    type:    String,
    trim:    true,
    default: null,
    match:   [/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'],
    // sparse index allows multiple null values
    index:   { sparse: true, unique: true },
  },

  // ── IDENTITY LOCK — Phase 2 addition ──────────────────────────────────────
  // phoneVerified: the mandatory gate before any platform access.
  // Set to true only after successful OTP verification via /api/users/phone/verify-otp.
  // Admin (zorvexinfo@gmail.com) is permanently exempt from this gate.
  phoneVerified: {
    type:    Boolean,
    default: false,
  },

  // OTP state — selected: false on all sub-fields except attempts & expiresAt
  // so the verification middleware can check expiry without leaking the code.
  phoneOtp: {
    type:    PhoneOtpSchema,
    default: () => ({ code: null, expiresAt: null, attempts: 0, lastSentAt: null }),
    select:  false,   // never returned in any query unless explicitly requested
  },

  // ── AUTHENTICATION ────────────────────────────────────────────────────────
  password: {
    type:      String,
    minlength: [6, 'Password must be at least 6 characters'],
    select:    false,   // never returned in queries by default
    default:   null,
  },

  authProvider: {
    type:    String,
    enum:    ['local', 'google'],
    default: 'local',
  },

  googleId: {
    type:   String,
    default: null,
    index:  { sparse: true, unique: true },
  },

  firebaseUid: {
    type:   String,
    default: null,
    index:  { sparse: true, unique: true },
  },

  // ── ROLE ──────────────────────────────────────────────────────────────────
  // admin role is auto-assigned to ADMIN_EMAIL only — see pre-save hook.
  // Role escalation via API is blocked in routes/auth.js.
  role: {
    type:    String,
    enum:    ['buyer', 'artist', 'admin'],
    default: 'buyer',
  },

  // ── STATUS ────────────────────────────────────────────────────────────────
  // isVerified: email/Google email_verified status — separate from phoneVerified.
  isVerified: {
    type:    Boolean,
    default: false,
  },

  isActive: {
    type:    Boolean,
    default: true,
  },

  // ── PROFILE ───────────────────────────────────────────────────────────────
  avatar: {
    type:    String,
    default: null,
  },

  // Artists: reference to their ArtistProfile document
  artistProfile: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'ArtistProfile',
    default: null,
  },

  // ── SAVED ADDRESSES ───────────────────────────────────────────────────────
  // Last 2 delivery addresses for buyer convenience (auto-saved on order creation).
  savedAddresses: {
    type:     [SavedAddressSchema],
    validate: [
      (arr) => arr.length <= 2,
      'Maximum 2 saved addresses allowed',
    ],
    default:  [],
  },

}, {
  timestamps: true,
  // Ensure virtual fields are serialized
  toJSON:   { virtuals: true },
  toObject: { virtuals: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: Has the user completed all onboarding requirements?
// Used by the frontend guardRoute to decide where to redirect.
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.virtual('isOnboarded').get(function () {
  // Admin is always onboarded
  if (this.role === 'admin') return true;
  return !!(this.phone && this.phoneVerified);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE HOOK: Admin restriction + password hashing
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.pre('save', async function (next) {

  // ── Admin role enforcement ──
  // Only zorvexinfo@gmail.com can ever be admin.
  if (this.role === 'admin' && this.email !== ADMIN_EMAIL) {
    return next(new Error('Unauthorized: This email cannot be assigned the admin role.'));
  }
  // Auto-promote the admin email regardless of what role was passed
  if (this.email === ADMIN_EMAIL && this.role !== 'admin') {
    this.role = 'admin';
  }

  // ── Admin is permanently phoneVerified — no gate applies ──
  if (this.email === ADMIN_EMAIL) {
    this.phoneVerified = true;
  }

  // ── Password handling — local auth only ──
  if (!this.isModified('password') || !this.password) return next();

  // Enforce password policy: must start with capital letter + contain a digit
  const passwordRegex = /^[A-Z](?=.*\d).+$/;
  if (!passwordRegex.test(this.password)) {
    return next(new Error(
      'Password must start with a capital letter and contain at least one number (e.g. Zorvex1)'
    ));
  }

  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Compare password (for local auth login)
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.matchPassword = async function (enteredPassword) {
  // Google-auth users have no password
  if (!this.password) return false;
  return bcrypt.compare(enteredPassword, this.password);
};

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Save delivery address — keeps only the 2 most recent, newest first.
// Deduplicates by matching pincode + address line to avoid duplicates.
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.saveAddress = function (addressObj) {
  // Remove exact duplicate if present
  this.savedAddresses = this.savedAddresses.filter(
    (a) => !(a.pincode === addressObj.pincode && a.address === addressObj.address)
  );
  // Prepend newest, trim to max 2
  this.savedAddresses.unshift(addressObj);
  if (this.savedAddresses.length > 2) {
    this.savedAddresses.pop();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Check if OTP is currently locked out (too many failed attempts)
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.isOtpLockedOut = function () {
  if (!this.phoneOtp) return false;
  return this.phoneOtp.attempts >= OTP_MAX_ATTEMPTS;
};

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Check if a new OTP can be sent (60-second cooldown between sends)
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.canSendOtp = function () {
  if (!this.phoneOtp?.lastSentAt) return true;
  const cooldownMs = 60 * 1000; // 60 seconds
  return (Date.now() - new Date(this.phoneOtp.lastSentAt).getTime()) >= cooldownMs;
};

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Clear OTP state after successful verification or manual reset
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.clearOtp = function () {
  this.phoneOtp = {
    code:       null,
    expiresAt:  null,
    attempts:   0,
    lastSentAt: null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Safe user projection for client responses
// Use this instead of manually listing fields in every route.
// Never includes: password, phoneOtp, googleId, firebaseUid
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.statics.sanitize = function (user) {
  return {
    _id:           user._id,
    name:          user.name,
    email:         user.email,
    phone:         user.phone,
    phoneVerified: user.phoneVerified,
    role:          user.role,
    avatar:        user.avatar,
    isVerified:    user.isVerified,
    isActive:      user.isActive,
    authProvider:  user.authProvider,
    artistProfile: user.artistProfile,
    savedAddresses: user.savedAddresses,
    createdAt:     user.createdAt,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
// email, googleId, firebaseUid, phone all have unique/sparse indexes declared
// inline above. Additional compound indexes for common query patterns:
UserSchema.index({ role: 1, isActive: 1 });
UserSchema.index({ phoneVerified: 1, role: 1 });
UserSchema.index({ createdAt: -1 });

module.exports = mongoose.model('User', UserSchema);
