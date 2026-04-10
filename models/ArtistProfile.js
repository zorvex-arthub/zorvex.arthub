/**
 * models/ArtistProfile.js
 * Updated:
 *   - Portfolio max 20 images (enforced by validator)
 *   - Availability: 'open' | 'busy' | 'closed' (was already there, confirmed)
 *   - admin.isVerified + admin.isFeatured flags
 */

const mongoose = require('mongoose');

// ── CUSTOM PRICING TIER ──
const PricingTierSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },   // e.g. "A4 Pencil Sketch"
  format:   { type: String, trim: true },                   // e.g. "A4", "Digital"
  price:    { type: Number, required: true, min: 1 },
  delivery: { type: String, default: '7–10 days' },
  featured: { type: Boolean, default: false },
}, { _id: true });

// ── PORTFOLIO ITEM ──
const PortfolioItemSchema = new mongoose.Schema({
  title:      { type: String, required: true, trim: true },
  category:   { type: String, trim: true },
  imageUrl:   { type: String },    // stored URL or base64
  uploadedAt: { type: Date, default: Date.now },
}, { _id: true });

const ArtistProfileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // ── PUBLIC PROFILE ──
  displayName: { type: String, trim: true },
  bio:         { type: String, maxlength: 600 },
  avatar:      { type: String, default: null },
  coverImage:  { type: String, default: null },

  // ── LOCATION (for Shiprocket pickup) ──
  location: {
    address:  { type: String, trim: true },
    city:     { type: String, trim: true },
    state:    { type: String, default: 'Kerala' },
    pincode:  {
      type: String, trim: true,
      match: [/^\d{6}$/, 'Enter a valid 6-digit pincode'],
    },
    landmark: { type: String, trim: true },
  },

  // ── SPECIALITIES / TAGS ──
  tags: [{ type: String, trim: true }],

  // ── CATEGORIES OFFERED ──
  categories: [{
    type: String,
    enum: ['drawing', 'painting', 'digital', 'fashion', 'unique', 'custom'],
  }],

  // ── CUSTOM PRICING ──
  pricingTiers: [PricingTierSchema],

  // ── PORTFOLIO — MAX 20 IMAGES ──
  portfolio: {
    type: [PortfolioItemSchema],
    validate: {
      validator: arr => arr.length <= 20,
      message: 'Portfolio cannot exceed 20 images.',
    },
    default: [],
  },

  // ── STATS ──
  stats: {
    totalOrders:     { type: Number, default: 0 },
    completedOrders: { type: Number, default: 0 },
    avgRating:       { type: Number, default: 0 },
    totalReviews:    { type: Number, default: 0 },
    responseTime:    { type: String, default: '< 24 hrs' },
    memberSince:     { type: Date, default: Date.now },
  },

  // ── AVAILABILITY ──
  // open   = accepting new orders
  // busy   = working on existing orders, not accepting new
  // closed = temporarily unavailable
  availability: {
    type: String,
    enum: ['open', 'busy', 'closed'],
    default: 'open',
  },

  // ── ADMIN FLAGS ──
  admin: {
    isVerified: { type: Boolean, default: false },   // admin-verified artist
    isFeatured: { type: Boolean, default: false },   // featured on browse page
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },

  // ── SHIPROCKET READINESS ──
  pickupReady: {
    isReady:    { type: Boolean, default: false },
    orderId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    notifiedAt: { type: Date, default: null },
  },

}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: Is the profile complete enough to appear publicly?
// ─────────────────────────────────────────────────────────────────────────────
ArtistProfileSchema.virtual('isPublic').get(function () {
  return !!(
    this.displayName &&
    this.bio &&
    this.location?.pincode &&
    this.portfolio.length > 0 &&
    this.pricingTiers.length > 0
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// METHOD: Add portfolio image (enforces 20-image limit)
// ─────────────────────────────────────────────────────────────────────────────
ArtistProfileSchema.methods.addPortfolioItem = function (item) {
  if (this.portfolio.length >= 20) {
    throw new Error('Portfolio cannot exceed 20 images. Please remove one first.');
  }
  this.portfolio.push(item);
};

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
ArtistProfileSchema.index({ 'admin.isVerified': 1, availability: 1 });
ArtistProfileSchema.index({ tags: 1 });
ArtistProfileSchema.index({ categories: 1 });

module.exports = mongoose.model('ArtistProfile', ArtistProfileSchema);
