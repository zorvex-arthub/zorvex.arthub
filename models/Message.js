/**
 * models/Message.js
 *
 * Chat message for the ZorvEx order-scoped messaging system.
 *
 * Design principles:
 *   - Each message belongs to exactly one Order (order-scoped chat).
 *   - Buyer and artist can send messages; admin can read all but sends via admin chat.
 *   - PII detection flags messages containing phone numbers or emails
 *     so the frontend can warn the user without blocking the message.
 *   - Messages are never hard-deleted — they may be needed for dispute resolution.
 *   - readBy array tracks which user IDs have seen the message (for unread counts).
 *
 * Indexes are designed for the two primary access patterns:
 *   1. Load all messages for an order — GET /api/chat/:orderId
 *   2. Count unread messages for an order/user pair — GET /api/chat/:orderId/unread
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// PII DETECTION PATTERNS
// Used before saving — flags but does NOT block the message.
// ─────────────────────────────────────────────────────────────────────────────
const PII_PATTERNS = [
  // Indian mobile numbers: 10-digit starting with 6-9, optionally prefixed +91 or 0
  /(?:(?:\+91|0)?[6-9]\d{9})/,
  // Email addresses
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
  // WhatsApp mentions (common bypass attempt)
  /whatsapp/i,
  // Instagram/social handles used to move off-platform
  /(?:insta(?:gram)?|ig)\s*[:@]/i,
];

const hasPii = (text) => PII_PATTERNS.some((pattern) => pattern.test(text));

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const MessageSchema = new mongoose.Schema({

  // ── CONTEXT ───────────────────────────────────────────────────────────────
  // Every message is tied to exactly one Order.
  order: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Order',
    required: [true, 'Message must belong to an order'],
    index:    true,
  },

  // ── SENDER ────────────────────────────────────────────────────────────────
  sender: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'Message must have a sender'],
  },

  // Denormalized role at send-time so admin chat views work even if
  // a user's role later changes (shouldn't happen, but defensive).
  senderRole: {
    type: String,
    enum: ['buyer', 'artist', 'admin'],
  },

  // ── CONTENT ───────────────────────────────────────────────────────────────
  text: {
    type:      String,
    required:  [true, 'Message text is required'],
    maxlength: [2000, 'Message cannot exceed 2000 characters'],
    trim:      true,
  },

  // ── PII FLAG ──────────────────────────────────────────────────────────────
  // Set automatically in pre-save hook if the text matches PII patterns.
  // Used by frontend to display a warning banner on the message bubble.
  // Does NOT block the message from being saved.
  piiDetected: {
    type:    Boolean,
    default: false,
  },

  // ── READ TRACKING ─────────────────────────────────────────────────────────
  // Array of User ObjectIds who have loaded/seen this message.
  // Used to compute unread counts per user without a separate collection.
  readBy: {
    type:    [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    default: [],
  },

  // ── SOFT DELETE ───────────────────────────────────────────────────────────
  // Messages are never hard-deleted. Admins can soft-delete for moderation.
  // Frontend must filter isDeleted: true messages out of the render.
  isDeleted: {
    type:    Boolean,
    default: false,
  },

  // If deleted, who deleted it and why (admin moderation audit trail)
  deletedBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },

  deletedReason: {
    type:    String,
    default: null,
  },

}, {
  // Use a single createdAt timestamp — messages are immutable once sent
  // (no updatedAt needed; soft-deletion modifies isDeleted not the message)
  timestamps: { createdAt: true, updatedAt: false },
  toJSON:     { virtuals: true },
  toObject:   { virtuals: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: Auto-detect PII in message text
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.pre('save', function (next) {
  if (this.isModified('text') || this.isNew) {
    this.piiDetected = hasPii(this.text);
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: Display text
// Returns a placeholder for soft-deleted messages so the UI can show
// "[Message removed by admin]" instead of the original text.
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.virtual('displayText').get(function () {
  if (this.isDeleted) return '[This message was removed by an administrator]';
  return this.text;
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE METHOD: Mark this message as read by a specific user
// Does NOT save — caller must call save() or use a bulk update.
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.methods.markReadBy = function (userId) {
  const alreadyRead = this.readBy.some(
    (id) => id.toString() === userId.toString()
  );
  if (!alreadyRead) {
    this.readBy.push(userId);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Load all messages for an order, sorted oldest → newest.
// Populates sender with just the fields the frontend needs.
// Admin can read any order; buyer and artist restricted to their own orders.
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.statics.forOrder = function (orderId) {
  return this.find({ order: orderId, isDeleted: false })
    .populate('sender', 'name avatar role')
    .sort({ createdAt: 1 })
    .lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Count unread messages for a specific user in a specific order
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.statics.countUnread = function (orderId, userId) {
  return this.countDocuments({
    order:     orderId,
    isDeleted: false,
    sender:    { $ne: userId },       // not sent by this user
    readBy:    { $not: { $in: [userId] } },  // not yet read by this user
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Mark all messages in an order as read by a specific user
// Efficient bulk update — used when a user opens an order chat.
// ─────────────────────────────────────────────────────────────────────────────
MessageSchema.statics.markAllReadByUser = function (orderId, userId) {
  return this.updateMany(
    {
      order:     orderId,
      isDeleted: false,
      sender:    { $ne: userId },
      readBy:    { $not: { $in: [userId] } },
    },
    { $addToSet: { readBy: userId } }
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
// Primary: all messages for an order, newest first
MessageSchema.index({ order: 1, createdAt: 1 });

// Unread count query: order + not in readBy + not deleted
MessageSchema.index({ order: 1, readBy: 1, isDeleted: 1 });

// Admin: find all messages from a specific sender across orders
MessageSchema.index({ sender: 1, createdAt: -1 });

module.exports = mongoose.model('Message', MessageSchema);
