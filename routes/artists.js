const express  = require('express');
const router   = express.Router();
const ArtistProfile = require('../models/ArtistProfile');
const Review        = require('../models/Review');
const { protect, authorize } = require('../middleware/auth');

// ── GET /api/artists ── (Browse all artists — public)
router.get('/', async (req, res) => {
  try {
    const { category, search, availability } = req.query;
    const filter = {};
    if (category)     filter.categories = category;
    if (availability) filter.availability = availability;

    let query = ArtistProfile.find(filter)
      .populate('user', 'name email avatar')
      .select('-portfolio -pickupReady');

    if (search) {
      query = ArtistProfile.find({
        ...filter,
        $or: [
          { displayName: { $regex: search, $options: 'i' } },
          { tags:         { $in: [new RegExp(search, 'i')] } },
          { 'location.city': { $regex: search, $options: 'i' } }
        ]
      }).populate('user', 'name email avatar');
    }

    const artists = await query.sort({ 'stats.avgRating': -1 });
    res.json({ success: true, count: artists.length, artists });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/artists/:id ── (Single artist profile — public)
router.get('/:id', async (req, res) => {
  try {
    const profile = await ArtistProfile.findById(req.params.id)
      .populate('user', 'name email avatar createdAt');

    if (!profile) return res.status(404).json({ success: false, message: 'Artist not found' });

    // Get reviews for this artist
    const reviews = await Review.find({ artist: profile.user._id, isVisible: true })
      .populate('buyer', 'name avatar')
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ success: true, profile, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/artists/profile ── (Artist updates own profile)
router.put('/profile', protect, authorize('artist'), async (req, res) => {
  try {
    const {
      displayName, bio, tags, categories,
      pricingTiers, availability, location,
      avatar, coverImage
    } = req.body;

    const updateData = {};
    if (displayName !== undefined) updateData.displayName = displayName;
    if (bio !== undefined)         updateData.bio = bio;
    if (tags !== undefined)        updateData.tags = tags;
    if (categories !== undefined)  updateData.categories = categories;
    if (availability !== undefined)updateData.availability = availability;
    if (avatar !== undefined)      updateData.avatar = avatar;
    if (coverImage !== undefined)  updateData.coverImage = coverImage;

    // Validate location — pincode is important for Shiprocket
    if (location) {
      if (location.pincode && !/^\d{6}$/.test(location.pincode)) {
        return res.status(400).json({ success: false, message: 'Invalid pincode — must be 6 digits' });
      }
      updateData.location = location;
    }

    // Validate pricing tiers
    if (pricingTiers !== undefined) {
      if (!Array.isArray(pricingTiers)) {
        return res.status(400).json({ success: false, message: 'pricingTiers must be an array' });
      }
      for (const tier of pricingTiers) {
        if (!tier.name || !tier.price || tier.price < 1) {
          return res.status(400).json({
            success: false,
            message: 'Each pricing tier needs a name and a valid price'
          });
        }
      }
      updateData.pricingTiers = pricingTiers;
    }

    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $set: updateData },
      { new: true, runValidators: true }
    ).populate('user', 'name email');

    if (!profile) return res.status(404).json({ success: false, message: 'Artist profile not found' });

    res.json({ success: true, profile });
  } catch (err) {
    console.error('[Artist Profile Update]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/artists/portfolio ── (Add portfolio item)
router.post('/portfolio', protect, authorize('artist'), async (req, res) => {
  try {
    const { title, category, imageUrl } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Title is required' });

    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $push: { portfolio: { title, category, imageUrl } } },
      { new: true }
    );

    res.json({ success: true, portfolio: profile.portfolio });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/artists/portfolio/:itemId ──
router.delete('/portfolio/:itemId', protect, authorize('artist'), async (req, res) => {
  try {
    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $pull: { portfolio: { _id: req.params.itemId } } },
      { new: true }
    );
    res.json({ success: true, portfolio: profile.portfolio });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/artists/:id/pricing ── (Get artist's pricing tiers — for order form)
router.get('/:id/pricing', async (req, res) => {
  try {
    const profile = await ArtistProfile.findById(req.params.id)
      .select('pricingTiers categories displayName availability');
    if (!profile) return res.status(404).json({ success: false, message: 'Artist not found' });

    res.json({
      success: true,
      pricingTiers: profile.pricingTiers,
      categories:   profile.categories,
      displayName:  profile.displayName,
      availability: profile.availability
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/artists/pickup-ready ── (Artist marks work ready for pickup)
router.post('/pickup-ready', protect, authorize('artist'), async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const profile = await ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      {
        'pickupReady.isReady':    true,
        'pickupReady.orderId':    orderId,
        'pickupReady.notifiedAt': new Date()
      },
      { new: true }
    ).populate('user', 'name');

    // Send pickup notification to Admin
    const Order = require('../models/Order');
    const order = await Order.findById(orderId);
    if (order) {
      const emailUtil = require('../utils/email');
      await emailUtil.sendPickupReadyToAdmin(
        process.env.MAIL_USER || 'zorvexinfo@gmail.com',
        profile.user,
        { ...order.toObject(), artistPickupAddress: profile.location }
      );
    }

    res.json({ success: true, message: 'Admin notified for pickup', profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
