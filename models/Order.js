const mongoose = require('mongoose');

// ── STATUS HISTORY ENTRY ──
const StatusHistorySchema = new mongoose.Schema({
  status:    { type: String, required: true },
  note:      { type: String },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  time:      { type: Date, default: Date.now }
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  // ── PARTIES ──
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  artist: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true    // LOCKED when order is created from artist profile
  },
  artistProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ArtistProfile'
  },

  // ── ORDER DETAILS ──
  category:    { type: String, required: true },
  subCategory: { type: String },
  description: { type: String, required: true, maxlength: 1000 },
  deadline:    { type: Date, required: true },
  deliveryType:{ type: String, enum: ['physical', 'digital'], required: true },

  // ── SELECTED PRICING TIER (from artist's custom pricing) ──
  selectedTier: {
    name:     { type: String },
    format:   { type: String },
    basePrice:{ type: Number }
  },

  // ── PRICING BREAKDOWN ──
  pricing: {
    basePrice:       { type: Number, default: 0 },
    platformFee:     { type: Number, default: 0 },   // 10% commission
    deliveryFee:     { type: Number, default: 0 },
    totalAmount:     { type: Number, default: 0 },
    advanceAmount:   { type: Number, default: 0 },   // 50% of total
    remainingAmount: { type: Number, default: 0 }
  },

  // ── DELIVERY ADDRESS (hidden from artist) ──
  deliveryAddress: {
    name:    { type: String },
    phone:   { type: String },
    address: { type: String },
    city:    { type: String },
    state:   { type: String },
    pincode: { type: String }
  },

  // ── BUYER PHONE (hidden from artist) ──
  buyerPhone: { type: String },

  // ── REFERENCE IMAGE ──
  referenceImage: { type: String, default: null },

  // ── PAYMENT ──
  payment: {
    advancePaid:    { type: Boolean, default: false },
    advancePaidAt:  { type: Date, default: null },
    razorpayOrderId:{ type: String, default: null },
    razorpayPaymentId:{ type: String, default: null },
    fullPaid:       { type: Boolean, default: false },
    fullPaidAt:     { type: Date, default: null }
  },

  // ── STATUS FLOW ──
  // request_sent → waiting → accepted → advance_paid → in_progress
  //              → completed → shipped → delivered    | rejected
  status: {
    type: String,
    enum: [
      'request_sent', 'waiting', 'accepted', 'advance_paid',
      'in_progress', 'completed', 'shipped', 'delivered', 'rejected'
    ],
    default: 'request_sent'
  },
  statusHistory: [StatusHistorySchema],
  rejectionReason: { type: String, default: null },

  // ── SHIPPING ──
  shipping: {
    trackingId:  { type: String, default: null },
    carrier:     { type: String, default: 'India Post' },
    shippedAt:   { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    shiprocketOrderId: { type: String, default: null }
  },

  // ── ARTWORK FILE (digital delivery) ──
  artworkFile: {
    url:         { type: String, default: null },
    uploadedAt:  { type: Date, default: null },
    viewedAt:    { type: Date, default: null },   // view-once tracking
    viewed:      { type: Boolean, default: false }
  },

  // ── DELIVERY FEE CALCULATION ──
  deliveryCalc: {
    buyerPincode:  { type: String },
    artistPincode: { type: String },
    estimatedFee:  { type: Number, default: 0 },
    calculatedAt:  { type: Date }
  },

  // ── FLAGS ──
  cancelLocked: { type: Boolean, default: false },  // true after advance paid
  reviewLeft:   { type: Boolean, default: false }   // prevent duplicate reviews

}, {
  timestamps: true
});

// ── VIRTUAL: Can this order be reviewed? ──
OrderSchema.virtual('canReview').get(function () {
  return this.status === 'delivered' && !this.reviewLeft;
});

// ── PRE-SAVE: Calculate pricing ──
OrderSchema.pre('save', function (next) {
  if (this.isModified('pricing.basePrice') || this.isModified('pricing.deliveryFee')) {
    const base     = this.pricing.basePrice || 0;
    const fee      = Math.round(base * 0.10);          // 10% platform commission
    const delivery = this.pricing.deliveryFee || 0;
    const total    = base + fee + delivery;
    this.pricing.platformFee     = fee;
    this.pricing.totalAmount     = total;
    this.pricing.advanceAmount   = Math.round(total * 0.5);
    this.pricing.remainingAmount = total - Math.round(total * 0.5);
  }
  next();
});

// ── INDEXES ──
OrderSchema.index({ buyer: 1, status: 1 });
OrderSchema.index({ artist: 1, status: 1 });
OrderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', OrderSchema);
