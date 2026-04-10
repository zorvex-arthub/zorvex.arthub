/**
 * models/Blacklist.js
 * Fraud prevention: block users by userId, email, phone, or IP.
 * Checked in auth middleware before every protected action.
 */

const mongoose = require('mongoose');

const BlacklistSchema = new mongoose.Schema({
  // ── WHAT IS BLOCKED ──
  type: {
    type: String,
    enum: ['user', 'email', 'phone', 'ip'],
    required: true,
  },

  // The actual value to match against
  value: {
    type: String,
    required: true,
    lowercase: true,   // normalize emails
    trim: true,
  },

  // ── OPTIONAL: link to User if blocking a specific account ──
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  // ── WHY THEY WERE BLOCKED ──
  reason: {
    type: String,
    required: [true, 'Reason for blacklisting is required'],
    trim: true,
  },

  // ── WHO BLOCKED THEM ──
  blockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // ── OPTIONAL EXPIRY (null = permanent) ──
  expiresAt: {
    type: Date,
    default: null,
  },

  isActive: {
    type: Boolean,
    default: true,
  },

}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES — fast lookup at middleware layer
// ─────────────────────────────────────────────────────────────────────────────
BlacklistSchema.index({ type: 1, value: 1 }, { unique: true });
BlacklistSchema.index({ userId: 1 });
BlacklistSchema.index({ isActive: 1, expiresAt: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Check if a value is currently blacklisted
// ─────────────────────────────────────────────────────────────────────────────
BlacklistSchema.statics.isBlocked = async function (type, value) {
  const now = new Date();
  const entry = await this.findOne({
    type,
    value: value.toLowerCase().trim(),
    isActive: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  });
  return !!entry;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Check by userId
// ─────────────────────────────────────────────────────────────────────────────
BlacklistSchema.statics.isUserBlocked = async function (userId) {
  const now = new Date();
  const entry = await this.findOne({
    type: 'user',
    userId,
    isActive: true,
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: now } },
    ],
  });
  return !!entry;
};

module.exports = mongoose.model('Blacklist', BlacklistSchema);
