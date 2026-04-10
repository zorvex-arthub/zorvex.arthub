/**
 * models/Review.js
 *
 * Buyer review for a completed and delivered ZorvEx commission.
 *
 * Business rules (enforced at model and route level):
 *   - One review per order — enforced by unique index on 'order' field
 *     AND by Order.reviewLeft flag (set to true after review is submitted).
 *   - Only buyers can submit reviews.
 *   - Order must be in 'delivered' status before a review can be submitted.
 *   - Minimum 10 characters, maximum 1000 characters for review text.
 *   - Rating must be an integer between 1 and 5.
 *
 * After a review is saved (post-save hook):
 *   1. Order.reviewLeft is set to true (prevents duplicate review attempts).
 *   2. ArtistProfile.stats.avgRating and stats.totalReviews are recalculated
 *      using an aggregation for accuracy.
 *
 * Public access:
 *   GET /api/reviews/artist/:profileId — returns all reviews for an artist,
 *   sorted newest first, paginated. No auth required (public browse page).
 */

const mongoose = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// VALID REVIEW TAGS
// Optional single-tag categorization for the review (shown as a pill badge).
// Helps surface relevant reviews (e.g. "Pencil Portrait" buyers can filter).
// ─────────────────────────────────────────────────────────────────────────────
const VALID_TAGS = [
  'Pencil Portrait',
  'Watercolour',
  'Digital Art',
  'Oil Painting',
  'Charcoal',
  'Sketch',
  'Custom Illustration',
  'Fashion Art',
  'Abstract',
  'Other',
];

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA
// ─────────────────────────────────────────────────────────────────────────────
const ReviewSchema = new mongoose.Schema({

  // ── CONTEXT ───────────────────────────────────────────────────────────────
  // One review per order — unique index enforced below.
  order: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'Order',
    required: [true, 'Review must be linked to an order'],
    unique:   true,   // hard constraint: one review per order
  },

  // Denormalized references for fast queries without joins
  buyer: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'Review must have a buyer'],
  },

  artist: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: [true, 'Review must reference the artist user'],
  },

  artistProfile: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'ArtistProfile',
    required: [true, 'Review must reference the artist profile'],
  },

  // ── REVIEW CONTENT ────────────────────────────────────────────────────────
  rating: {
    type:     Number,
    required: [true, 'Rating is required'],
    min:      [1, 'Rating must be at least 1'],
    max:      [5, 'Rating cannot exceed 5'],
    // Enforce integer only — no 4.5 stars
    validate: {
      validator: (v) => Number.isInteger(v),
      message:   'Rating must be a whole number between 1 and 5',
    },
  },

  text: {
    type:      String,
    required:  [true, 'Review text is required'],
    trim:      true,
    minlength: [10,   'Review must be at least 10 characters'],
    maxlength: [1000, 'Review cannot exceed 1000 characters'],
  },

  // Optional single-category tag — helps buyers browse by art type
  tag: {
    type:    String,
    trim:    true,
    default: null,
    validate: {
      validator: (v) => v === null || v === '' || VALID_TAGS.includes(v),
      message:   `Tag must be one of: ${VALID_TAGS.join(', ')}`,
    },
  },

  // ── MODERATION ────────────────────────────────────────────────────────────
  // Admin can hide a review without deleting it (e.g. spam, abuse).
  isVisible: {
    type:    Boolean,
    default: true,
  },

  // If hidden, a reason must be recorded for the audit trail
  hiddenReason: {
    type:    String,
    default: null,
  },

  hiddenBy: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     'User',
    default: null,
  },

  hiddenAt: {
    type:    Date,
    default: null,
  },

}, {
  timestamps: true,
  toJSON:     { virtuals: true },
  toObject:   { virtuals: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-VALIDATE: Normalize empty tag to null
// Ensures that an empty string submitted from the frontend doesn't fail
// the VALID_TAGS validator.
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.pre('validate', function (next) {
  if (this.tag === '') this.tag = null;
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// POST-SAVE: Update Order.reviewLeft flag + recalculate artist stats
// Both updates are non-fatal — a failed stats update must not break the review.
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.post('save', async function (doc) {
  // ── 1. Mark order as reviewed ──
  try {
    const Order = mongoose.model('Order');
    await Order.findByIdAndUpdate(doc.order, { reviewLeft: true });
  } catch (err) {
    console.error('Review post-save: failed to set order.reviewLeft:', err.message);
  }

  // ── 2. Recalculate artist stats via aggregation ──
  // This is more accurate than incrementing because it handles edge cases
  // (hidden reviews, deleted reviews) correctly if we ever change visibility.
  try {
    const ArtistProfile = mongoose.model('ArtistProfile');

    const [agg] = await mongoose.model('Review').aggregate([
      {
        $match: {
          artistProfile: doc.artistProfile,
          isVisible:     true,
        },
      },
      {
        $group: {
          _id:          null,
          avgRating:    { $avg: '$rating' },
          totalReviews: { $sum: 1 },
        },
      },
    ]);

    if (agg) {
      await ArtistProfile.findByIdAndUpdate(doc.artistProfile, {
        'stats.avgRating':    Math.round(agg.avgRating * 10) / 10, // round to 1 decimal
        'stats.totalReviews': agg.totalReviews,
      });
    }
  } catch (err) {
    console.error('Review post-save: failed to update artist stats:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Load paginated public reviews for an artist profile.
// Only visible reviews are returned. Newest first.
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.statics.forArtist = function (artistProfileId, { page = 1, limit = 10 } = {}) {
  const skip = (page - 1) * limit;
  return this.find({ artistProfile: artistProfileId, isVisible: true })
    .populate('buyer', 'name avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Count visible reviews for an artist profile (for pagination metadata)
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.statics.countForArtist = function (artistProfileId) {
  return this.countDocuments({ artistProfile: artistProfileId, isVisible: true });
};

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: Get delivered orders that a buyer can still review
// Returns Order documents where:
//   - buyer matches
//   - status is 'delivered'
//   - reviewLeft is false
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.statics.eligibleOrders = async function (buyerId) {
  const Order = mongoose.model('Order');
  return Order.find({
    buyer:      buyerId,
    status:     'delivered',
    reviewLeft: false,
  })
    .populate('artistProfile', 'displayName avatar')
    .populate('artist', 'name')
    .select('category selectedTier status createdAt artistProfile artist orderId')
    .sort({ createdAt: -1 })
    .lean();
};

// ─────────────────────────────────────────────────────────────────────────────
// VIRTUAL: Star display (e.g. "★★★★☆")
// Convenience for server-side rendering if ever needed.
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.virtual('starsDisplay').get(function () {
  const filled = '★'.repeat(this.rating);
  const empty  = '☆'.repeat(5 - this.rating);
  return filled + empty;
});

// ─────────────────────────────────────────────────────────────────────────────
// EXPOSE VALID TAGS so routes can import them for validation without
// re-defining the list.
// ─────────────────────────────────────────────────────────────────────────────
ReviewSchema.statics.VALID_TAGS = VALID_TAGS;

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
// order has a unique index declared inline (one review per order)
ReviewSchema.index({ artistProfile: 1, isVisible: 1, createdAt: -1 });
ReviewSchema.index({ buyer: 1, createdAt: -1 });
ReviewSchema.index({ rating: 1 });

module.exports = mongoose.model('Review', ReviewSchema);
