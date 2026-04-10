/**
 * routes/reviews.js
 *
 * Buyer review system for delivered commissions.
 *
 * Endpoints:
 *
 *   GET  /api/reviews/artist/:profileId   — Public: paginated reviews for an artist
 *   GET  /api/reviews/eligible            — Buyer: orders eligible for review
 *   POST /api/reviews                     — Buyer: submit a review for a delivered order
 *   GET  /api/reviews/order/:orderId      — Get the review for a specific order (buyer/artist/admin)
 *
 *   ADMIN
 *   GET   /api/reviews/admin/all          — List all reviews with filters
 *   PATCH /api/reviews/admin/:id/hide     — Hide a review (moderation)
 *   PATCH /api/reviews/admin/:id/show     — Re-show a hidden review
 *
 * Eligibility rules (enforced server-side):
 *   1. Order status must be 'delivered'
 *   2. Order.reviewLeft must be false
 *   3. req.user must be the order's buyer
 *   4. Only one review per order (unique index on Review.order)
 */

'use strict';

const express  = require('express');
const mongoose = require('mongoose');
const Review   = require('../models/Review');
const Order    = require('../models/Order');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/artist/:profileId
// PUBLIC — no authentication required.
// Returns paginated, visible reviews for an artist profile.
// Used by: artist-profile.html (browse page) and order.html.
//
// Query params:
//   page  — page number (default 1)
//   limit — results per page (default 10, max 50)
//
// Response:
//   {
//     reviews:    Review[],
//     pagination: { page, limit, total, totalPages },
//     avgRating:  number,
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/artist/:profileId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.profileId)) {
      return res.status(400).json({ message: 'Invalid artist profile ID.' });
    }

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const [reviews, total] = await Promise.all([
      Review.forArtist(req.params.profileId, { page, limit }),
      Review.countForArtist(req.params.profileId),
    ]);

    // Compute average rating from the returned page for display
    // (the accurate full average lives on ArtistProfile.stats.avgRating)
    const avgRating = reviews.length
      ? Math.round(
          (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10
        ) / 10
      : 0;

    return res.json({
      reviews,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      avgRating,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// All routes below require authentication
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/eligible
// Returns all delivered orders for the calling buyer that have NOT yet been
// reviewed. Used to populate the "Leave a Review" section in dashboard-buyer.
//
// Response:
//   { eligibleOrders: Order[] }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/eligible', requireRole('buyer'), async (req, res, next) => {
  try {
    const eligibleOrders = await Review.eligibleOrders(req.user._id);
    return res.json({ eligibleOrders });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reviews
// Submit a review for a delivered order.
// Buyer only. One review per order. Order must be delivered and unreviewed.
//
// Body:
//   orderId  — the order being reviewed (required)
//   rating   — integer 1–5 (required)
//   text     — review text, min 10 chars (required)
//   tag      — optional tag from Review.VALID_TAGS
//
// Response:
//   { message: string, review: Review }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireRole('buyer'), async (req, res, next) => {
  try {
    const { orderId, rating, text, tag } = req.body;

    // ── Input validation ──
    if (!orderId) {
      return res.status(400).json({ message: 'orderId is required.' });
    }
    if (!isValidId(orderId)) {
      return res.status(400).json({ message: 'Invalid orderId.' });
    }

    const parsedRating = parseInt(rating, 10);
    if (isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({ message: 'Rating must be an integer between 1 and 5.' });
    }

    if (!text || !text.toString().trim()) {
      return res.status(400).json({ message: 'Review text is required.' });
    }
    if (text.toString().trim().length < 10) {
      return res.status(400).json({ message: 'Review must be at least 10 characters.' });
    }
    if (text.toString().trim().length > 1000) {
      return res.status(400).json({ message: 'Review cannot exceed 1000 characters.' });
    }

    // Validate tag if provided
    if (tag && tag.trim() && !Review.VALID_TAGS.includes(tag.trim())) {
      return res.status(400).json({
        message: `Invalid tag. Must be one of: ${Review.VALID_TAGS.join(', ')}`,
      });
    }

    // ── Order eligibility checks ──
    const order = await Order.findById(orderId)
      .populate('artistProfile', '_id')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    // Must be the buyer
    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'You can only review orders you placed.',
      });
    }

    // Order must be delivered
    if (order.status !== 'delivered') {
      return res.status(400).json({
        message: 'You can only leave a review after the order has been delivered.',
        currentStatus: order.status,
      });
    }

    // Must not already be reviewed
    if (order.reviewLeft) {
      return res.status(409).json({
        message: 'You have already submitted a review for this order.',
      });
    }

    // Double-check the database unique index (handles race conditions)
    const existing = await Review.findOne({ order: orderId });
    if (existing) {
      return res.status(409).json({
        message: 'A review for this order already exists.',
      });
    }

    // ── Create the review ──
    // Post-save hook will: set order.reviewLeft = true + recalculate artist stats
    const review = await Review.create({
      order:         orderId,
      buyer:         req.user._id,
      artist:        order.artist,
      artistProfile: order.artistProfile?._id || order.artistProfile,
      rating:        parsedRating,
      text:          text.toString().trim(),
      tag:           tag?.trim() || null,
    });

    // Populate for the response
    const populated = await Review.findById(review._id)
      .populate('buyer', 'name avatar')
      .lean();

    return res.status(201).json({
      message: 'Your review has been submitted. Thank you!',
      review:  populated,
    });
  } catch (err) {
    // Unique constraint violation (race condition — extremely rare)
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'A review for this order already exists.',
      });
    }
    // Mongoose validation errors
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0], errors: messages });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/order/:orderId
// Get the review for a specific order (if it exists).
// Accessible by: the buyer, the artist, or an admin.
//
// Response:
//   { review: Review | null }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/order/:orderId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.orderId)
      .select('buyer artist')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    // Access check: must be buyer, artist, or admin
    const userId   = req.user._id.toString();
    const buyerId  = order.buyer.toString();
    const artistId = order.artist.toString();

    if (req.user.role !== 'admin' && userId !== buyerId && userId !== artistId) {
      return res.status(403).json({
        message: 'You do not have access to this order\'s review.',
      });
    }

    const review = await Review.findOne({ order: req.params.orderId })
      .populate('buyer', 'name avatar')
      .lean();

    return res.json({ review: review || null });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — all require admin role
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/admin/all
// List all reviews with optional filters for moderation.
//
// Query params:
//   isVisible — 'true' | 'false' (default: all)
//   page      — page number (default 1)
//   limit     — results per page (default 20, max 100)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const { isVisible, page = 1, limit = 20 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip     = (pageNum - 1) * limitNum;

    const filter = {};
    if (isVisible === 'true')  filter.isVisible = true;
    if (isVisible === 'false') filter.isVisible = false;

    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .populate('buyer',         'name email')
        .populate('artistProfile', 'displayName')
        .populate('order',         'orderId category status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Review.countDocuments(filter),
    ]);

    return res.json({
      reviews,
      pagination: {
        page:       pageNum,
        limit:      limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/reviews/admin/:id/hide
// Hide a review from public display (moderation action).
// The review is NOT deleted — just made invisible.
// Stats are recalculated after hiding (post-save hook on Review model
// only fires on create, so we manually update stats here).
//
// Body: { reason: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/admin/:id/hide', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid review ID.' });
    }

    const { reason } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: 'A reason for hiding this review is required.' });
    }

    const review = await Review.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isVisible:     false,
          hiddenReason:  reason.trim(),
          hiddenBy:      req.user._id,
          hiddenAt:      new Date(),
        },
      },
      { new: true }
    );

    if (!review) {
      return res.status(404).json({ message: 'Review not found.' });
    }

    // Recalculate artist stats since a review was hidden
    await recalcArtistStats(review.artistProfile);

    return res.json({
      message: 'Review hidden from public display.',
      review,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/reviews/admin/:id/show
// Restore a previously hidden review to public display.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/admin/:id/show', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid review ID.' });
    }

    const review = await Review.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          isVisible:    true,
          hiddenReason: null,
          hiddenBy:     null,
          hiddenAt:     null,
        },
      },
      { new: true }
    );

    if (!review) {
      return res.status(404).json({ message: 'Review not found.' });
    }

    // Recalculate artist stats since a review was restored
    await recalcArtistStats(review.artistProfile);

    return res.json({
      message: 'Review restored to public display.',
      review,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER: Recalculate artist stats after a review visibility change.
// Mirrors the logic in Review post-save hook so admin hide/show keeps stats
// accurate without triggering a full save.
// ─────────────────────────────────────────────────────────────────────────────
async function recalcArtistStats(artistProfileId) {
  if (!artistProfileId) return;
  try {
    const ArtistProfile = require('../models/ArtistProfile');

    const [agg] = await Review.aggregate([
      {
        $match: {
          artistProfile: mongoose.Types.ObjectId.isValid(artistProfileId)
            ? new mongoose.Types.ObjectId(artistProfileId.toString())
            : artistProfileId,
          isVisible: true,
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

    await ArtistProfile.findByIdAndUpdate(artistProfileId, {
      'stats.avgRating':    agg ? Math.round(agg.avgRating * 10) / 10 : 0,
      'stats.totalReviews': agg ? agg.totalReviews : 0,
    });
  } catch (err) {
    // Non-fatal — log but don't break the response
    console.error('recalcArtistStats error:', err.message);
  }
}

module.exports = router;
