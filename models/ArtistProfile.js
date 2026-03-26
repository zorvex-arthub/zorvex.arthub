const mongoose = require('mongoose');

// ── CUSTOM PRICING TIER ──
const PricingTierSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },  // e.g. "A4 Pencil Sketch"
  format:   { type: String, trim: true },                  // e.g. "A4", "Digital", "Logo"
  price:    { type: Number, required: true, min: 1 },
  delivery: { type: String, default: '7–10 days' },
  featured: { type: Boolean, default: false }
}, { _id: true });

// ── PORTFOLIO ITEM ──
const PortfolioItemSchema = new mongoose.Schema({
  title:    { type: String, required: true },
  category: { type: String },
  imageUrl: { type: String },   // stored URL or base64
  uploadedAt: { type: Date, default: Date.now }
}, { _id: true });

const ArtistProfileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },

  // ── PUBLIC PROFILE ──
  displayName:  { type: String, trim: true },
  bio:          { type: String, maxlength: 600 },
  avatar:       { type: String, default: null },   // image URL or base64
  coverImage:   { type: String, default: null },

  // ── LOCATION (for Shiprocket pickup) ──
  location: {
    address:  { type: String, trim: true },
    city:     { type: String, trim: true },
    state:    { type: String, default: 'Kerala' },
    pincode:  { type: String, trim: true, match: [/^\d{6}$/, 'Enter a valid 6-digit pincode'] },
    landmark: { type: String, trim: true }
  },

  // ── SPECIALITIES / TAGS ──
  tags: [{ type: String, trim: true }],

  // ── CATEGORIES OFFERED ──
  // Only these will show in the buyer's order form
  categories: [{
    type: String,
    enum: ['drawing', 'painting', 'digital', 'fashion', 'unique', 'custom']
  }],

  // ── CUSTOM PRICING (dynamic — set by artist) ──
  pricingTiers: [PricingTierSchema],

  // ── PORTFOLIO ──
  portfolio: [PortfolioItemSchema],

  // ── STATS ──
  stats: {
    totalOrders:    { type: Number, default: 0 },
    completedOrders:{ type: Number, default: 0 },
    avgRating:      { type: Number, default: 0 },
    totalReviews:   { type: Number, default: 0 },
    responseTime:   { type: String, default: '< 24 hrs' },
    memberSince:    { type: Date, default: Date.now }
  },

  // ── AVAILABILITY ──
  availability: {
    type: String,
    enum: ['open', 'busy', 'closed'],
    default: 'open'
  },

  // ── SHIPROCKET READINESS ──
  // Set by artist when work is ready for pickup
  pickupReady: {
    isReady:      { type: Boolean, default: false },
    orderId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    notifiedAt:   { type: Date, default: null }
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('ArtistProfile', ArtistProfileSchema);
