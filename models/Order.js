/**
 * models/Order.js
 *
 * Complete order lifecycle for ZorvEx commissions.
 *
 * Phase 2 additions (Fix Plan Step 4):
 *   - orderId: auto-generated human-readable display ID (e.g. "ZVX-A3F9B2")
 *     Resolves the o.orderId undefined issue across all 4 frontend order pages
 *     and the admin dashboard.
 *
 * Delivery types:
 *   'physical' — printed/painted artwork shipped to buyer via Shiprocket/India Post
 *   'digital'  — high-res file delivered in-app (view-once secure download token)
 *
 * Status flow:
 *   request_sent → waiting → accepted → advance_paid → in_progress
 *   → completed → [physical: shipped → delivered] [digital: delivered]
 *   → rejected (can occur at any pre-payment stage)
 */

const mongoose = require('mongoose');
const crypto   = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Generate a short, human-readable order ID
// Format: ZVX-XXXXXX where X is alphanumeric (uppercase)
// Uses timestamp + random bytes for guaranteed uniqueness.
// ─────────────────────────────────────────────────────────────────────────────
const generateOrderId = () => {
  // Base-36 of current timestamp (ms) gives ~8 chars; we take last 4
  const timePart   = Date.now().toString(36).toUpperCase().slice(-4);
  // 2 random bytes → 4 hex chars → uppercase
  const randomPart = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `ZVX-${timePart}${randomPart}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// STATUS HISTORY ENTRY
// Immutable log of every status transition — used for the order timeline UI.
// ─────────────────────────────────────────────────────────────────────────────
const StatusHistorySchema = new mongoose.Schema({
  status:    { type: String, required: true },
  note:      { type: String, default: '' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  time:      { type: Date, default: Date.now },
}, { _id: false });

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const OrderSchema = new mongoose.Schema({

  // ── HUMAN-READABLE ORDER ID ───────────────────────────────────────────────
  // Phase 2 Fix: every dashboard and order page reads o.orderId.
  // This field provides a stable, short display ID (e.g. "ZVX-A3F9B2").
  // unique: true ensures no collisions even under high concurrency.
  orderId: {
    type:    String,
    unique:  true,
    default: generateOrderId,
    index:   true,
  },

  // ── PARTIES ───────────────────────────────────────────────────────────────
  buyer: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'Buyer is required'],
  },

  artist: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'Artist is required'],
  },

  artistProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref:  'ArtistProfile',
  },

  // ── ORDER DETAILS ─────────────────────────────────────────────────────────
  category: {
    type:     String,
    required: [true, 'Category is required'],
    trim:     true,
  },

  subCategory: {
    type:    String,
    trim:    true,
    default: '',
  },

  description: {
    type:      String,
    required:  [true, 'Description is required'],
    maxlength: [1000, 'Description cannot exceed 1000 characters'],
    trim:      true,
  },

  deadline: {
    type:     Date,
    required: [true, 'Deadline is required'],
  },

  // ── DELIVERY TYPE ─────────────────────────────────────────────────────────
  // 'physical' = printed/painted artwork shipped to buyer
  // 'digital'  = high-res file delivered in-app (view-once)
  deliveryType: {
    type:     String,
    enum:     {
      values:  ['physical', 'digital'],
      message: "deliveryType must be 'physical' or 'digital'",
    },
    required: [true, 'Delivery type is required'],
  },

  // ── SELECTED PRICING TIER ─────────────────────────────────────────────────
  // Snapshot of the artist's pricing tier at time of order — immutable after creation.
  selectedTier: {
    name:      { type: String, default: '' },
    format:    { type: String, default: '' },
    basePrice: { type: Number, default: 0 },
  },

  // ── PRICING BREAKDOWN ─────────────────────────────────────────────────────
  // All pricing fields are calculated in pre-save hook.
  // Frontend reads: totalAmount, advanceAmount, remainingAmount, platformFee, deliveryFee
  // NOTE: these are the canonical field names — previously some frontend pages
  //       incorrectly used 'total', 'advance', 'platformCommission'.
  pricing: {
    basePrice:       { type: Number, default: 0, min: 0 },
    platformFee:     { type: Number, default: 0, min: 0 },  // 10% commission
    deliveryFee:     { type: Number, default: 0, min: 0 },  // 0 for digital
    totalAmount:     { type: Number, default: 0, min: 0 },  // base + fee + delivery
    advanceAmount:   { type: Number, default: 0, min: 0 },  // 50% of total
    remainingAmount: { type: Number, default: 0, min: 0 },  // remaining 50%
  },

  // ── PHYSICAL ONLY: Delivery address ───────────────────────────────────────
  // Intentionally hidden from artist view (see routes/orders.js GET /:id).
  // Field names match exactly what order.html's submitOrder() sends.
  deliveryAddress: {
    name:         { type: String, trim: true },   // recipient name
    phone:        { type: String, trim: true },
    address:      { type: String, trim: true },   // address line 1
    city:         { type: String, trim: true },
    state:        { type: String, trim: true },
    pincode:      { type: String, trim: true },
    // Internal flag — marks whether this address has been saved to buyer's User doc
    _savedToUser: { type: Boolean, default: false },
  },

  // ── BUYER PHONE (for shipping label when buyer != recipient) ──────────────
  buyerPhone: {
    type:    String,
    trim:    true,
    default: null,
  },

  // ── REFERENCE IMAGE ───────────────────────────────────────────────────────
  // Optional base64 or CDN URL uploaded by buyer at order time
  referenceImage: {
    type:    String,
    default: null,
  },

  // ── PAYMENT ───────────────────────────────────────────────────────────────
  payment: {
    advancePaid:       { type: Boolean, default: false },
    advancePaidAt:     { type: Date,    default: null },
    razorpayOrderId:   { type: String,  default: null },
    razorpayPaymentId: { type: String,  default: null },
    fullPaid:          { type: Boolean, default: false },
    fullPaidAt:        { type: Date,    default: null },
  },

  // ── STATUS ────────────────────────────────────────────────────────────────
  // Full allowed transitions documented above in file header.
  status: {
    type:    String,
    enum:    {
      values: [
        'request_sent',
        'waiting',
        'accepted',
        'advance_paid',
        'in_progress',
        'completed',
        'shipped',
        'delivered',
        'rejected',
      ],
      message: 'Invalid order status: {VALUE}',
    },
    default: 'request_sent',
  },

  // Immutable history log — one entry per status transition
  statusHistory: {
    type:    [StatusHistorySchema],
    default: [],
  },

  rejectionReason: {
    type:    String,
    default: null,
  },

  // ── PHYSICAL ONLY: Shipping ───────────────────────────────────────────────
  // Canonical path to tracking: order.shipping.trackingId (not order.trackingId)
  shipping: {
    trackingId:          { type: String, default: null },
    carrier:             { type: String, default: 'India Post' },
    shippedAt:           { type: Date,   default: null },
    deliveredAt:         { type: Date,   default: null },
    shiprocketOrderId:   { type: String, default: null },
    shiprocketShipmentId:{ type: String, default: null },
  },

  // ── DIGITAL ONLY: Artwork file (view-once) ────────────────────────────────
  // The download URL and token are redacted from all non-admin, non-buyer-delivered responses.
  artworkFile: {
    url:        { type: String,  default: null },
    uploadedAt: { type: Date,    default: null },
    viewedAt:   { type: Date,    default: null },
    viewed:     { type: Boolean, default: false },
    // One-time secure download token — invalidated after first use
    token:      { type: String,  default: null },
    tokenUsed:  { type: Boolean, default: false },
  },

  // ── DELIVERY FEE CALCULATION CACHE (physical only) ────────────────────────
  deliveryCalc: {
    buyerPincode:  { type: String },
    artistPincode: { type: String },
    estimatedFee:  { type: Number, default: 0 },
    calculatedAt:  { type: Date },
  },

  // ── FLAGS ─────────────────────────────────────────────────────────────────
  // cancelLocked: true after advance payment — prevents buyer cancellation
  cancelLocked: {
    type:    Boolean,
    default: false,
  },

  // reviewLeft: true after buyer submits a review — prevents duplicate reviews
  reviewLeft: {
    type:    Boolean,
    default: false,
  },

  // adminNotes: internal notes added by admin when forwarding or reviewing
  adminNotes: {
    type:    String,
    default: null,
  },

}, {
  timestamps: true,
  toJSON:     { virtuals: true },
  toObject:   { virtuals: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-VALIDATE: Enforce physical-order address requirement
// ─────────────────────────────────────────────────────────────────────────────
OrderSchema.pre('validate', function (next) {
  if (this.deliveryType === 'physical') {
    const a = this.deliveryAddress;
    if (!a || !a.address || !a.pincode || !a.city) {
      return next(new Error(
        'Physical orders require a complete delivery address (address, city, pincode).'
      ));
    }
  }
  if (this.deliveryType === 'digital') {
    // Digital orders never have a delivery fee
    this.pricing.deliveryFee = 0;
  }
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: Recalculate pricing whenever base or delivery fee changes
// ─────────────────────────────────────────────────────────────────────────────
OrderSchema.pre('save', function (next) {
  const shouldRecalc =
    this.isModified('pricing.basePrice') ||
    this.isModified('pricing.deliveryFee') ||
    this.isNew;

  if (shouldRecalc) {
    const base     = this.pricing.basePrice     || 0;
    const delivery = this.pricing.deliveryFee   || 0;
    const fee      = Math.round(base * 0.10);        // 10% platform commission
    const total    = base + fee + delivery;
    const advance  = Math.round(total * 0.50);       // 50% advance

    this.pricing.platformFee     = fee;
    this.pricing.totalAmount     = total;
    this.pricing.advanceAmount   = advance;
    this.pricing.remainingAmount = total - advance;
  }

  // Lock cancellation once advance is paid
  if (this.isModified('payment.advancePaid') && this.payment.advancePaid) {
    this.cancelLocked = true;
  }

  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST-SAVE: Auto-save delivery address to buyer's User document (last 2)
// Non-fatal — address saving failure must never break the order save.
// ─────────────────────────────────────────────────────────────────────────────
OrderSchema.post('save', async function (doc) {
  if (
    doc.deliveryType === 'physical' &&
    doc.deliveryAddress?.pincode &&
    !doc.deliveryAddress._savedToUser
  ) {
    try {
      const User  = mongoose.model('User');
      const buyer = await User.findById(doc.buyer);
      if (buyer) {
        buyer.saveAddress({
          label:   'Saved',
          name:    doc.deliveryAddress.name,
          phone:   doc.deliveryAddress.phone,
          address: doc.deliveryAddress.address,
          city:    doc.deliveryAddress.city,
          state:   doc.deliveryAddress.state,
          pincode: doc.deliveryAddress.pincode,
        });
        await buyer.save();
        // Mark so we don't re-save on subsequent order saves
        await doc.constructor.findByIdAndUpdate(doc._id, {
          'deliveryAddress._savedToUser': true,
        });
      }
    } catch (err) {
      // Non-fatal: log but do not rethrow
      console.error('Order post-save: address auto-save failed:', err.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUALS
// ─────────────────────────────────────────────────────────────────────────────

// Can the buyer leave a review?
OrderSchema.virtual('canReview').get(function () {
  return this.status === 'delivered' && !this.reviewLeft;
});

// Shorthand type checks used in route logic
OrderSchema.virtual('isDigital').get(function () {
  return this.deliveryType === 'digital';
});

OrderSchema.virtual('isPhysical').get(function () {
  return this.deliveryType === 'physical';
});

// Is the order in an active (non-terminal) state?
OrderSchema.virtual('isActive').get(function () {
  return !['delivered', 'rejected'].includes(this.status);
});

// Is the order awaiting any payment action?
OrderSchema.virtual('needsAdvancePayment').get(function () {
  return this.status === 'accepted' && !this.payment.advancePaid;
});

OrderSchema.virtual('needsFinalPayment').get(function () {
  return this.status === 'completed' && !this.payment.fullPaid;
});

// ─────────────────────────────────────────────────────────────────────────────
// INSTANCE METHOD: Add a status history entry
// Use this instead of direct assignment to ensure the log is always updated.
// Does NOT call save() — caller is responsible for persisting.
// ─────────────────────────────────────────────────────────────────────────────
OrderSchema.methods.pushStatus = function (status, note, userId) {
  this.status = status;
  this.statusHistory.push({
    status,
    note:      note || '',
    updatedBy: userId || null,
    time:      new Date(),
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
OrderSchema.index({ buyer:  1, status: 1 });
OrderSchema.index({ artist: 1, status: 1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ deliveryType: 1, status: 1 });
// orderId has a unique index declared inline above

module.exports = mongoose.model('Order', OrderSchema);
