/**
 * routes/artists.js
 *
 * Artist profile management and public discovery routes.
 *
 * Phase 5 fixes applied:
 *   - GET /me/profile registered BEFORE /:id to prevent route collision
 *     (previously /profile/me was registered AFTER router.use(protect),
 *      causing GET /artists/profile to match /:id with id="profile")
 *   - GET /:id now returns location.city + location.state (not pincode)
 *     so artist-profile.html can display the artist's city
 *   - PUT /availability changed to PATCH /availability
 *     (matches ZX.artists.setAvailability() which sends PATCH)
 *   - GET /me/profile path aligns with zorvex-api.js call: /artists/me/profile
 *   - GET /:id response includes reviews from Review model
 *
 * Public routes (no auth):
 *   GET  /api/artists              — Browse/search verified public artists
 *   GET  /api/artists/:id          — Single artist profile (with reviews)
 *
 * Protected routes (artist role required):
 *   GET    /api/artists/me/profile         — Own full profile
 *   POST   /api/artists/profile            — Create artist profile
 *   PUT    /api/artists/profile            — Update artist profile fields
 *   PATCH  /api/artists/availability       — Quick availability toggle
 *   POST   /api/artists/portfolio          — Add portfolio image (max 20)
 *   DELETE /api/artists/portfolio/:itemId  — Remove portfolio image
 *   POST   /api/artists/pricing            — Add pricing tier (max 10)
 *   PUT    /api/artists/pricing/:tierId    — Update pricing tier
 *   DELETE /api/artists/pricing/:tierId    — Remove pricing tier
 */

'use strict';

const express       = require('express');
const mongoose      = require('mongoose');
const ArtistProfile = require('../models/ArtistProfile');
const User          = require('../models/User');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const estimateBase64SizeMB = (str = '') => (str.length * 0.75) / (1024 * 1024);

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: GET /api/artists
// Browse and search verified, publicly-complete artist profiles.
//
// Query params:
//   tags       — comma-separated  e.g. "portrait,watercolour"
//   category   — single value     e.g. "painting"
//   sort       — "rating" (default) | "orders" | "newest" | "featured"
//   page       — page number (default 1)
//   limit      — results per page (default 12, max 48)
//   search     — free-text on displayName / bio / tags
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      tags,
      category,
      sort  = 'rating',
      page  = 1,
      limit = 12,
      search,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(48, Math.max(1, parseInt(limit, 10) || 12));
    const skip     = (pageNum - 1) * limitNum;

    // ── Build filter ──
    const filter = {
      'admin.isVerified': true,
      availability: { $in: ['open', 'busy'] },
    };

    if (category) {
      const allowed = ['drawing', 'painting', 'digital', 'fashion', 'unique', 'custom'];
      if (!allowed.includes(category)) {
        return res.status(400).json({
          message: `Invalid category. Must be one of: ${allowed.join(', ')}`,
        });
      }
      filter.categories = category;
    }

    if (tags) {
      const tagList = tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (tagList.length > 0) filter.tags = { $in: tagList };
    }

    if (search) {
      const regex = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );
      filter.$or = [
        { displayName: regex },
        { bio:         regex },
        { tags:        regex },
      ];
    }

    // ── Build sort ──
    const sortMap = {
      rating:   { 'stats.avgRating': -1, 'stats.totalReviews': -1 },
      orders:   { 'stats.completedOrders': -1 },
      newest:   { 'stats.memberSince': -1 },
      featured: { 'admin.isFeatured': -1, 'stats.avgRating': -1 },
    };
    const sortQuery = sortMap[sort] || sortMap.rating;

    const [profiles, total] = await Promise.all([
      ArtistProfile.find(filter)
        .select(
          'displayName bio avatar coverImage tags categories ' +
          'pricingTiers stats availability admin.isFeatured admin.isVerified ' +
          'portfolio location'
        )
        .populate('user', 'name email avatar')
        .sort(sortQuery)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      ArtistProfile.countDocuments(filter),
    ]);

    // Strip portfolio to first 3 items for browse cards (performance)
    // Strip location.pincode from public browse (city/state only)
    const sanitized = profiles.map((p) => ({
      ...p,
      portfolio: (p.portfolio || []).slice(0, 3),
      location: {
        city:  p.location?.city  || null,
        state: p.location?.state || null,
        // pincode intentionally omitted
      },
    }));

    return res.json({
      artists: sanitized,
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
// Phase 5 Fix: GET /api/artists/me/profile MUST be registered BEFORE /:id
// because Express matches routes in registration order.
// If /:id came first, "me" would be treated as an ObjectId (invalid → 400).
// This route requires authentication — applied inline so it doesn't affect
// the public /:id route that follows.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/me/profile',
  protect,
  requireRole('artist'),
  async (req, res, next) => {
    try {
      const profile = await ArtistProfile.findOne({ user: req.user._id })
        .populate('user', 'name email phone avatar')
        .lean();

      if (!profile) {
        return res.status(404).json({
          message: 'Artist profile not found. Please create one first.',
        });
      }

      return res.json({ profile });
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: GET /api/artists/:id
// Fetch a single public artist profile by ArtistProfile _id or User _id.
// Phase 5 fix: location.city and location.state are included in public response.
//              location.pincode is always stripped (privacy).
//              reviews are fetched from Review model and included in response.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid artist ID.' });
    }

    // Try by ArtistProfile _id first, then by user reference
    let profile = await ArtistProfile.findById(req.params.id)
      .populate('user', 'name email avatar createdAt')
      .lean();

    if (!profile) {
      profile = await ArtistProfile.findOne({ user: req.params.id })
        .populate('user', 'name email avatar createdAt')
        .lean();
    }

    if (!profile) {
      return res.status(404).json({ message: 'Artist not found.' });
    }

    if (!profile.admin?.isVerified) {
      return res.status(404).json({ message: 'Artist not found.' });
    }

    // ── Phase 5 fix: build safe public profile ──
    // Destructure to remove admin internals and private location data,
    // then re-add only the public-safe fields.
    const {
      admin,
      pickupReady,
      location,
      ...publicProfile
    } = profile;

    publicProfile.admin = {
      isVerified: admin.isVerified,
      isFeatured: admin.isFeatured,
    };

    // Include city + state for display; never include pincode
    publicProfile.location = {
      city:  location?.city  || null,
      state: location?.state || null,
    };

    // Fetch reviews for this profile (from Review model)
    // Import here to avoid circular dependency at module load
    let reviews = [];
    try {
      const Review = require('../models/Review');
      reviews = await Review.forArtist(profile._id, { page: 1, limit: 10 });
    } catch (revErr) {
      // Non-fatal: reviews failing shouldn't break the profile page
      console.error('Review fetch failed on artist profile:', revErr.message);
    }

    return res.json({ artist: publicProfile, reviews });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// All routes below require a verified artist session
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect, requireRole('artist'));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/artists/profile
// Create a new artist profile for the authenticated artist.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/profile', async (req, res, next) => {
  try {
    const userId = req.user._id;

    const existing = await ArtistProfile.findOne({ user: userId });
    if (existing) {
      return res.status(409).json({
        message: 'You already have an artist profile. Use PUT /profile to update it.',
      });
    }

    const {
      displayName,
      bio,
      avatar,
      coverImage,
      location,
      tags,
      categories,
      pricingTiers,
      availability,
    } = req.body;

    const profile = await ArtistProfile.create({
      user:         userId,
      displayName:  displayName  || '',
      bio:          bio          || '',
      avatar:       avatar       || null,
      coverImage:   coverImage   || null,
      location:     location     || {},
      tags:         Array.isArray(tags)         ? tags         : [],
      categories:   Array.isArray(categories)   ? categories   : [],
      pricingTiers: Array.isArray(pricingTiers) ? pricingTiers : [],
      availability: availability || 'open',
    });

    // Back-link profile on the User document
    await User.findByIdAndUpdate(userId, { artistProfile: profile._id });

    return res.status(201).json({
      message: 'Artist profile created successfully.',
      profile,
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0], errors: messages });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/artists/profile
// Update the authenticated artist's profile fields.
// Admin flags (isVerified, isFeatured) are NOT updatable here — admin only.
// pricingTiers is NOT in the allowed list — use the dedicated /pricing endpoints.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/profile', async (req, res, next) => {
  try {
    const ALLOWED = [
      'displayName',
      'bio',
      'avatar',
      'coverImage',
      'location',
      'tags',
      'categories',
      'availability',
    ];

    const updates = {};
    ALLOWED.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No valid fields provided for update.' });
    }

    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!profile) {
      return res.status(404).json({
        message: 'Artist profile not found. Please create one first.',
      });
    }

    return res.json({ message: 'Profile updated successfully.', profile });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0], errors: messages });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/artists/availability
// Phase 5 fix: was PUT — changed to PATCH to match ZX.artists.setAvailability()
// Quick availability toggle without a full profile update.
//
// Body: { availability: 'open' | 'busy' | 'closed' }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/availability', async (req, res, next) => {
  try {
    const { availability } = req.body;
    const allowed = ['open', 'busy', 'closed'];

    if (!allowed.includes(availability)) {
      return res.status(400).json({
        message: `Invalid availability. Must be one of: ${allowed.join(', ')}`,
      });
    }

    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $set: { availability } },
      { new: true }
    ).select('availability displayName');

    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    return res.json({
      message:      'Availability updated.',
      availability: profile.availability,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/artists/portfolio
// Add a portfolio item. Enforces the 20-image cap.
//
// Body: { title, category?, imageUrl }
// imageUrl can be a URL string or base64 data URI (max ~5 MB)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/portfolio', async (req, res, next) => {
  try {
    const { title, category, imageUrl } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: 'Portfolio item title is required.' });
    }
    if (!imageUrl) {
      return res.status(400).json({ message: 'An image (URL or base64) is required.' });
    }

    if (imageUrl.startsWith('data:') && estimateBase64SizeMB(imageUrl) > 5) {
      return res.status(400).json({ message: 'Image must be smaller than 5 MB.' });
    }

    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    try {
      profile.addPortfolioItem({
        title:    title.trim(),
        category: category || '',
        imageUrl,
      });
    } catch (limitErr) {
      return res.status(400).json({ message: limitErr.message });
    }

    await profile.save();

    const addedItem = profile.portfolio[profile.portfolio.length - 1];
    return res.status(201).json({
      message: 'Portfolio item added.',
      item:    addedItem,
      total:   profile.portfolio.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/artists/portfolio/:itemId
// Remove a single portfolio item by its subdocument _id.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/portfolio/:itemId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.itemId)) {
      return res.status(400).json({ message: 'Invalid portfolio item ID.' });
    }

    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    const before = profile.portfolio.length;
    profile.portfolio = profile.portfolio.filter(
      (item) => item._id.toString() !== req.params.itemId
    );

    if (profile.portfolio.length === before) {
      return res.status(404).json({ message: 'Portfolio item not found.' });
    }

    await profile.save();
    return res.json({
      message: 'Portfolio item removed.',
      total:   profile.portfolio.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/artists/pricing
// Add a new pricing tier.
//
// Body: { name, format?, price, delivery?, featured? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/pricing', async (req, res, next) => {
  try {
    const { name, format, price, delivery, featured } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Pricing tier name is required.' });
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice < 1) {
      return res.status(400).json({ message: 'Price must be a positive number (minimum ₹1).' });
    }

    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    if (profile.pricingTiers.length >= 10) {
      return res.status(400).json({ message: 'Maximum 10 pricing tiers allowed.' });
    }

    const duplicate = profile.pricingTiers.find(
      (t) => t.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({
        message: `A tier named "${name.trim()}" already exists.`,
      });
    }

    profile.pricingTiers.push({
      name:     name.trim(),
      format:   format   || '',
      price:    parsedPrice,
      delivery: delivery || '7–10 days',
      featured: featured === true,
    });

    await profile.save();

    const addedTier = profile.pricingTiers[profile.pricingTiers.length - 1];
    return res.status(201).json({
      message: 'Pricing tier added.',
      tier:    addedTier,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/artists/pricing/:tierId
// Update an existing pricing tier.
//
// Body: any subset of { name, format, price, delivery, featured }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/pricing/:tierId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.tierId)) {
      return res.status(400).json({ message: 'Invalid pricing tier ID.' });
    }

    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    const tier = profile.pricingTiers.id(req.params.tierId);
    if (!tier) {
      return res.status(404).json({ message: 'Pricing tier not found.' });
    }

    const ALLOWED = ['name', 'format', 'price', 'delivery', 'featured'];
    ALLOWED.forEach((field) => {
      if (req.body[field] !== undefined) {
        if (field === 'price') {
          const p = parseFloat(req.body[field]);
          if (!isNaN(p) && p >= 1) tier.price = p;
        } else {
          tier[field] = req.body[field];
        }
      }
    });

    await profile.save();
    return res.json({ message: 'Pricing tier updated.', tier });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/artists/pricing/:tierId
// Remove a pricing tier.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/pricing/:tierId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.tierId)) {
      return res.status(400).json({ message: 'Invalid pricing tier ID.' });
    }

    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    const before = profile.pricingTiers.length;
    profile.pricingTiers = profile.pricingTiers.filter(
      (t) => t._id.toString() !== req.params.tierId
    );

    if (profile.pricingTiers.length === before) {
      return res.status(404).json({ message: 'Pricing tier not found.' });
    }

    await profile.save();
    return res.json({ message: 'Pricing tier removed.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
