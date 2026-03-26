const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema({
  // ── ONLY allowed if order.status === 'delivered' && !order.reviewLeft ──
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
    unique: true   // one review per order
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  artist: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  artistProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ArtistProfile',
    required: true
  },
  rating: {
    type: Number,
    required: true,
    min: [1, 'Rating minimum is 1'],
    max: [5, 'Rating maximum is 5']
  },
  title: {
    type: String,
    trim: true,
    maxlength: 100
  },
  text: {
    type: String,
    required: true,
    trim: true,
    minlength: [10, 'Review must be at least 10 characters'],
    maxlength: [800, 'Review cannot exceed 800 characters']
  },
  tag: {
    type: String,  // e.g. "Pencil Portrait", "Digital Art" — from the order's category
    trim: true
  },
  isVerified: {
    type: Boolean,
    default: true  // always true since we verify via order
  },
  isVisible: {
    type: Boolean,
    default: true  // admin can hide if needed
  }
}, {
  timestamps: true
});

// ── POST-SAVE: Update artist's average rating ──
ReviewSchema.post('save', async function () {
  const ArtistProfile = mongoose.model('ArtistProfile');
  const Order = mongoose.model('Order');

  try {
    // Recalculate artist average rating
    const stats = await mongoose.model('Review').aggregate([
      { $match: { artist: this.artist, isVisible: true } },
      { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);

    if (stats.length > 0) {
      await ArtistProfile.findOneAndUpdate(
        { user: this.artist },
        {
          'stats.avgRating':   Math.round(stats[0].avgRating * 10) / 10,
          'stats.totalReviews': stats[0].count
        }
      );
    }

    // Mark the order as reviewed (prevent duplicate)
    await Order.findByIdAndUpdate(this.order, { reviewLeft: true });

  } catch (err) {
    console.error('Review post-save hook error:', err);
  }
});

ReviewSchema.index({ artist: 1, isVisible: 1 });
ReviewSchema.index({ buyer: 1 });
ReviewSchema.index({ order: 1 }, { unique: true });

module.exports = mongoose.model('Review', ReviewSchema);
