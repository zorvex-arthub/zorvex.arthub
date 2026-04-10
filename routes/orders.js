/**
 * routes/orders.js
 *
 * Complete order lifecycle management for ZorvEx.
 *
 * Phase 5 fixes applied:
 *   - Added GET  /admin/all    (was missing — used by admin dashboard)
 *   - Added GET  /admin/stats  (was missing — used by admin KPI cards)
 *   - Added PATCH /:id/admin-forward  (was missing — admin forwards to artist)
 *   - Added PATCH /:id/admin-ship     (was missing — admin adds tracking)
 *   - Added PATCH /:id/admin-deliver  (was missing — admin marks delivered)
 *   - Added PATCH /:id/artist-action  (replaces non-existent PUT accept/reject)
 *   - Fixed GET /artist path: was /artist/mine → now /artist (matches backend)
 *   - Fixed GET /:id/tracking: uses populate() so assertOrderAccess works
 *   - order.pushStatus() now used from Order model method (Phase 2)
 *   - All pricing fields use canonical names: totalAmount, advanceAmount,
 *     remainingAmount, platformFee (never 'total', 'advance', 'platformCommission')
 *
 * ── BUYER ROUTES ──
 *   POST   /api/orders                         — Place a new commission order
 *   GET    /api/orders/my                      — List buyer's own orders
 *   GET    /api/orders/:id                     — Get a single order
 *   POST   /api/orders/:id/cancel              — Cancel before advance is paid
 *
 * ── PAYMENT ROUTES ──
 *   POST   /api/orders/:id/pay/advance         — Create Razorpay order (50% advance)
 *   POST   /api/orders/:id/pay/advance/verify  — Verify advance payment signature
 *   POST   /api/orders/:id/pay/final           — Create Razorpay order (50% final)
 *   POST   /api/orders/:id/pay/final/verify    — Verify final payment signature
 *
 * ── ARTIST ROUTES ──
 *   GET    /api/orders/artist                  — List artist's incoming orders
 *   PATCH  /api/orders/:id/artist-action       — Accept or reject an order
 *   PATCH  /api/orders/:id/start               — Mark work as started
 *   PATCH  /api/orders/:id/complete            — Submit completed artwork
 *   PUT    /api/orders/:id/ship                — Artist marks physical as shipped
 *
 * ── ADMIN ROUTES ──
 *   GET    /api/orders/admin/all               — All orders (filters + pagination)
 *   GET    /api/orders/admin/stats             — KPI stats
 *   PATCH  /api/orders/:id/admin-forward       — Forward request_sent → waiting
 *   PATCH  /api/orders/:id/admin-ship          — Add tracking + mark shipped
 *   PATCH  /api/orders/:id/admin-deliver       — Mark as delivered
 *
 * ── DIGITAL DELIVERY ──
 *   GET    /api/orders/:id/download            — One-time secure download (buyer)
 *
 * ── SHIPPING ──
 *   GET    /api/orders/shipping/estimate       — Estimate delivery fee pre-order
 *   GET    /api/orders/:id/tracking            — Live Shiprocket tracking
 *
 * ── DELIVERY FEE ──
 *   GET    /api/orders/delivery-fee            — Calculate fee for order form
 */

'use strict';

const express       = require('express');
const crypto        = require('crypto');
const Razorpay      = require('razorpay');
const mongoose      = require('mongoose');
const Order         = require('../models/Order');
const ArtistProfile = require('../models/ArtistProfile');
const User          = require('../models/User');
const { protect, requireRole } = require('../middleware/auth');
const {
  calculateShipping,
  createShipment,
  getTrackingDetails,
} = require('../utils/delivery');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// RAZORPAY CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Convert ₹ → paise (Razorpay expects smallest currency unit) */
const toPaise = (amount) => Math.round(amount * 100);

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Verify a Razorpay payment signature */
const verifyRazorpaySignature = (razorpayOrderId, razorpayPaymentId, signature) => {
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return expectedSig === signature;
};

/**
 * Verify the requesting user owns this order (as buyer or artist).
 * Admin always has access.
 */
const assertOrderAccess = (order, user) => {
  if (user.role === 'admin') return;

  const buyerId  = order.buyer?._id?.toString()  || order.buyer?.toString();
  const artistId = order.artist?._id?.toString() || order.artist?.toString();
  const userId   = user._id.toString();

  if (userId !== buyerId && userId !== artistId) {
    const err  = new Error('You do not have access to this order.');
    err.status = 403;
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: GET /api/orders/shipping/estimate
// No auth required — used on the order form before login.
// Query: pickupPincode, deliveryPincode, weight (kg, default 0.5)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/shipping/estimate', async (req, res, next) => {
  try {
    const { pickupPincode, deliveryPincode, weight } = req.query;

    if (!pickupPincode || !deliveryPincode) {
      return res.status(400).json({
        message: 'Both pickupPincode and deliveryPincode are required.',
      });
    }

    const result = await calculateShipping(
      pickupPincode,
      deliveryPincode,
      parseFloat(weight) || 0.5
    );
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: GET /api/orders/delivery-fee
// Called from order.html when the buyer enters their pincode.
// Query: buyerPincode, artistId (User ID of the artist)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/delivery-fee', async (req, res, next) => {
  try {
    const { buyerPincode, artistId } = req.query;

    if (!buyerPincode || !artistId) {
      return res.status(400).json({ message: 'buyerPincode and artistId are required.' });
    }
    if (!isValidId(artistId)) {
      return res.status(400).json({ message: 'Invalid artistId.' });
    }

    const artistProfile = await ArtistProfile.findOne({ user: artistId })
      .select('location.pincode')
      .lean();

    if (!artistProfile?.location?.pincode) {
      // Artist has no pincode — return fallback
      return res.json({
        fee:           120,
        carrier:       'India Post',
        estimatedDays: '7–10 days',
        note:          'Standard rate — artist location not configured',
        disclaimer:    'Final shipping may vary',
      });
    }

    const result = await calculateShipping(
      artistProfile.location.pincode,
      buyerPincode
    );

    return res.json({
      fee:           result.fee,
      carrier:       result.carrier,
      estimatedDays: result.estimatedDays,
      note:          `From ${artistProfile.location.pincode} to ${buyerPincode}`,
      disclaimer:    'Estimated — final fee confirmed at order placement',
    });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// All routes below require authentication
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /api/orders/admin/all
// All orders with optional filters and pagination.
// IMPORTANT: This route MUST be registered before /:id to avoid
// "admin" being treated as an order ID.
//
// Query: status (comma-separated), deliveryType, page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const {
      status,
      deliveryType,
      page  = 1,
      limit = 25,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip     = (pageNum - 1) * limitNum;

    const filter = {};

    if (status) {
      const statuses = status.split(',').map((s) => s.trim()).filter(Boolean);
      filter.status  = statuses.length === 1 ? statuses[0] : { $in: statuses };
    }

    if (deliveryType && ['physical', 'digital'].includes(deliveryType)) {
      filter.deliveryType = deliveryType;
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('buyer',         'name email phone')
        .populate('artist',        'name email')
        .populate('artistProfile', 'displayName avatar location')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.json({
      orders,
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
// ADMIN: GET /api/orders/admin/stats
// Order counts per status + revenue totals for KPI cards.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/stats', requireRole('admin'), async (req, res, next) => {
  try {
    const [orderAgg, userCount] = await Promise.all([
      Order.aggregate([
        {
          $group: {
            _id:             '$status',
            count:           { $sum: 1 },
            totalCommission: { $sum: '$pricing.platformFee' },
            totalDelivery:   { $sum: '$pricing.deliveryFee' },
          },
        },
      ]),
      User.countDocuments({}),
    ]);

    const statusCounts  = {};
    let totalCommission = 0;
    let totalDelivery   = 0;

    for (const row of orderAgg) {
      statusCounts[row._id] = row.count;
      totalCommission += row.totalCommission || 0;
      totalDelivery   += row.totalDelivery   || 0;
    }

    return res.json({
      stats: {
        statusCounts,
        revenue: {
          totalCommission:   Math.round(totalCommission),
          totalDeliveryFees: Math.round(totalDelivery),
        },
        totalUsers: userCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUYER: GET /api/orders/my
// List the authenticated buyer's orders, newest first.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', requireRole('buyer'), async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));

    const filter = { buyer: req.user._id };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        // Never expose artwork URL or download token in list views
        .select('-artworkFile.url -artworkFile.token')
        .populate('artist',        'name avatar')
        .populate('artistProfile', 'displayName avatar')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.json({
      orders,
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
// ARTIST: GET /api/orders/artist
// List all orders assigned to the authenticated artist.
// Phase 5 fix: path was /artist/mine — corrected to /artist
// ─────────────────────────────────────────────────────────────────────────────
router.get('/artist', requireRole('artist'), async (req, res, next) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));

    const filter = { artist: req.user._id };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        // Never expose buyer's delivery address to the artist
        .select('-artworkFile.url -artworkFile.token -deliveryAddress')
        .populate('buyer', 'name avatar')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return res.json({
      orders,
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
// SHARED: GET /api/orders/:id
// Fetch a single order. Buyer, assigned artist, and admin can access.
// Delivery address is redacted from artist view.
// Artwork URL/token redacted unless buyer + delivered, or admin.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id)
      .populate('buyer',         'name email avatar phone')
      .populate('artist',        'name avatar email')
      .populate('artistProfile', 'displayName avatar location');

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    try {
      assertOrderAccess(order, req.user);
    } catch (accessErr) {
      return res.status(403).json({ message: accessErr.message });
    }

    const isArtist = order.artist?._id?.toString() === req.user._id.toString();
    const isBuyer  = order.buyer?._id?.toString()  === req.user._id.toString();
    const isAdmin  = req.user.role === 'admin';

    // Serialize with virtuals (canReview, isDigital, etc.)
    const orderObj = order.toObject({ virtuals: true });

    // Redact delivery address from artist view
    if (isArtist && !isAdmin) {
      delete orderObj.deliveryAddress;
    }

    // Redact artwork file unless: admin, or buyer after delivery
    if (!isAdmin && !(isBuyer && order.status === 'delivered')) {
      if (orderObj.artworkFile) {
        delete orderObj.artworkFile.url;
        delete orderObj.artworkFile.token;
      }
    }

    return res.json({ order: orderObj });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BUYER: POST /api/orders
// Place a new commission order.
//
// Body (physical):
//   artistId, artistProfileId, category, subCategory, description, deadline,
//   deliveryType: 'physical',
//   deliveryAddress: { name, phone, address, city, state, pincode },
//   selectedTier: { name, format, basePrice },
//   referenceImage?, buyerPhone?
//
// Body (digital):
//   artistId, artistProfileId, category, subCategory, description, deadline,
//   deliveryType: 'digital',
//   selectedTier: { name, format, basePrice },
//   referenceImage?, buyerPhone?
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', requireRole('buyer'), async (req, res, next) => {
  try {
    const {
      artistId,
      artistProfileId,
      category,
      subCategory,
      description,
      deadline,
      deliveryType,
      deliveryAddress,
      selectedTier,
      referenceImage,
      buyerPhone,
    } = req.body;

    // ── Basic field validation ──
    if (!artistId)                  return res.status(400).json({ message: 'artistId is required.' });
    if (!isValidId(artistId))       return res.status(400).json({ message: 'Invalid artistId.' });
    if (!category)                  return res.status(400).json({ message: 'category is required.' });
    if (!description)               return res.status(400).json({ message: 'description is required.' });
    if (!deadline)                  return res.status(400).json({ message: 'deadline is required.' });
    if (!deliveryType)              return res.status(400).json({ message: 'deliveryType is required.' });
    if (!selectedTier?.basePrice)   return res.status(400).json({ message: 'selectedTier.basePrice is required.' });

    const deadlineDate = new Date(deadline);
    if (isNaN(deadlineDate.getTime()) || deadlineDate <= new Date()) {
      return res.status(400).json({ message: 'Deadline must be a future date.' });
    }

    if (!['physical', 'digital'].includes(deliveryType)) {
      return res.status(400).json({ message: "deliveryType must be 'physical' or 'digital'." });
    }

    // ── Verify artist exists and is available ──
    const [artist, artistProfile] = await Promise.all([
      User.findById(artistId).select('name role isActive'),
      ArtistProfile.findOne({ user: artistId }).select('availability location pricingTiers _id'),
    ]);

    if (!artist || artist.role !== 'artist' || !artist.isActive) {
      return res.status(404).json({ message: 'Artist not found or unavailable.' });
    }
    if (!artistProfile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }
    if (artistProfile.availability === 'closed') {
      return res.status(400).json({ message: 'This artist is currently not accepting orders.' });
    }

    // ── Calculate delivery fee for physical orders ──
    let deliveryFee  = 0;
    let deliveryCalc = {};

    if (deliveryType === 'physical') {
      if (!deliveryAddress?.address || !deliveryAddress?.city || !deliveryAddress?.pincode) {
        return res.status(400).json({
          message: 'Physical orders require a complete delivery address (address, city, pincode).',
        });
      }

      if (artistProfile.location?.pincode) {
        try {
          const shippingResult = await calculateShipping(
            artistProfile.location.pincode,
            deliveryAddress.pincode
          );
          deliveryFee  = shippingResult.fee;
          deliveryCalc = {
            buyerPincode:  deliveryAddress.pincode,
            artistPincode: artistProfile.location.pincode,
            estimatedFee:  shippingResult.fee,
            calculatedAt:  new Date(),
          };
        } catch (shippingErr) {
          console.warn('Shipping estimate failed, using fallback:', shippingErr.message);
          deliveryFee = 120;
        }
      } else {
        deliveryFee = 120; // fallback when artist has no pincode
      }
    }

    // ── Build order document ──
    const orderData = {
      buyer:         req.user._id,
      artist:        artistId,
      artistProfile: artistProfileId || artistProfile._id,
      category:      category.trim(),
      subCategory:   subCategory?.trim() || '',
      description:   description.trim(),
      deadline:      deadlineDate,
      deliveryType,
      referenceImage: referenceImage || null,
      buyerPhone:    buyerPhone || req.user.phone || null,
      selectedTier: {
        name:      selectedTier.name      || '',
        format:    selectedTier.format    || '',
        basePrice: Number(selectedTier.basePrice),
      },
      pricing: {
        basePrice:   Number(selectedTier.basePrice),
        deliveryFee,
      },
      deliveryCalc,
    };

    if (deliveryType === 'physical') {
      orderData.deliveryAddress = {
        name:    deliveryAddress.name    || '',
        phone:   deliveryAddress.phone   || '',
        address: deliveryAddress.address || '',
        city:    deliveryAddress.city    || '',
        state:   deliveryAddress.state   || '',
        pincode: deliveryAddress.pincode || '',
        _savedToUser: false,
      };
    }

    const order = await Order.create(orderData);

    // Increment artist's total orders counter (non-fatal if it fails)
    ArtistProfile.findByIdAndUpdate(
      artistProfile._id,
      { $inc: { 'stats.totalOrders': 1 } }
    ).catch((e) => console.error('Artist stats increment failed:', e.message));

    return res.status(201).json({
      message: 'Commission request sent. Waiting for admin to review and forward.',
      orderId: order.orderId,
      _id:     order._id,
      pricing: order.pricing,
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
// BUYER: POST /api/orders/:id/cancel
// Cancel an order only if the advance has NOT been paid.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/cancel', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only cancel your own orders.' });
    }
    if (order.cancelLocked) {
      return res.status(400).json({
        message: 'Order cannot be cancelled after advance payment has been made.',
      });
    }
    if (['delivered', 'rejected'].includes(order.status)) {
      return res.status(400).json({
        message: `Cannot cancel an order with status "${order.status}".`,
      });
    }

    order.pushStatus('rejected', req.body.reason || 'Cancelled by buyer', req.user._id);
    await order.save();

    return res.json({ message: 'Order cancelled successfully.' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIST: PATCH /api/orders/:id/artist-action
// Accept or reject an order.
// Phase 5 fix: replaces non-existent PUT /accept and PUT /reject.
//
// Body: { action: 'accepted' | 'rejected', reason?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/artist-action', requireRole('artist'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { action, reason } = req.body;

    if (!['accepted', 'rejected'].includes(action)) {
      return res.status(400).json({
        message: "action must be 'accepted' or 'rejected'.",
      });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.artist.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This order is not assigned to you.' });
    }

    if (!['waiting', 'request_sent'].includes(order.status)) {
      return res.status(400).json({
        message: `Can only accept/reject orders in 'waiting' status. Current: "${order.status}".`,
      });
    }

    if (action === 'accepted') {
      order.pushStatus('accepted', 'Order accepted by artist', req.user._id);
    } else {
      if (!reason || !reason.trim()) {
        return res.status(400).json({ message: 'A reason is required when rejecting an order.' });
      }
      order.rejectionReason = reason.trim();
      order.pushStatus('rejected', reason.trim(), req.user._id);
    }

    await order.save();

    return res.json({
      message: action === 'accepted'
        ? 'Order accepted. Buyer will be notified to make the advance payment.'
        : 'Order declined.',
      status:  order.status,
      orderId: order.orderId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIST: PATCH /api/orders/:id/start
// Artist starts work after advance payment is confirmed.
// Status: advance_paid → in_progress
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/start', requireRole('artist'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.artist.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.status !== 'advance_paid') {
      return res.status(400).json({
        message: `Can only start work after advance is paid. Current: "${order.status}".`,
      });
    }

    order.pushStatus('in_progress', 'Artist started work', req.user._id);
    await order.save();

    return res.json({ message: 'Work started. Good luck!', status: order.status });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIST: PATCH /api/orders/:id/complete
// Artist marks artwork as complete and uploads the file (digital) or
// declares it ready for dispatch (physical).
// Status: in_progress → completed
//
// Body (digital):  { artworkUrl: string }
// Body (physical): no extra fields needed
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/complete', requireRole('artist'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.artist.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.status !== 'in_progress') {
      return res.status(400).json({
        message: `Order must be "in_progress" to mark complete. Current: "${order.status}".`,
      });
    }

    if (order.deliveryType === 'digital') {
      const { artworkUrl } = req.body;
      if (!artworkUrl || !artworkUrl.trim()) {
        return res.status(400).json({ message: 'artworkUrl is required for digital orders.' });
      }
      order.artworkFile.url        = artworkUrl.trim();
      order.artworkFile.uploadedAt = new Date();
    }

    // Increment artist completed orders stat (non-fatal)
    ArtistProfile.findOneAndUpdate(
      { user: req.user._id },
      { $inc: { 'stats.completedOrders': 1 } }
    ).catch((e) => console.error('Artist stats update failed:', e.message));

    order.pushStatus(
      'completed',
      order.deliveryType === 'digital'
        ? 'Digital artwork uploaded — awaiting admin review'
        : 'Physical artwork completed — awaiting dispatch',
      req.user._id
    );
    await order.save();

    return res.json({
      message: order.deliveryType === 'digital'
        ? 'Artwork submitted. Admin will review and release to buyer.'
        : 'Artwork marked complete. Admin will arrange shipping.',
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTIST: PUT /api/orders/:id/ship
// Artist manually dispatches a physical parcel (if shipping independently).
// Status: completed → shipped
//
// Body: { trackingId?: string, carrier?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id/ship', requireRole('artist'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id)
      .populate('buyer', 'name email');
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.artist.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.deliveryType !== 'physical') {
      return res.status(400).json({ message: 'Shipping is only for physical orders.' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({
        message: `Order must be "completed" to ship. Current: "${order.status}".`,
      });
    }

    const artistProfile = await ArtistProfile.findOne({ user: req.user._id });

    let trackingId        = req.body.trackingId || null;
    let carrier           = req.body.carrier    || 'India Post';
    let shiprocketOrderId = null;

    // Attempt Shiprocket booking if artist has a pincode
    if (artistProfile?.location?.pincode) {
      try {
        const result = await createShipment(order, artistProfile);
        trackingId        = result.trackingId        || trackingId;
        carrier           = result.carrier           || carrier;
        shiprocketOrderId = result.shiprocketOrderId || null;
      } catch (srErr) {
        console.warn('Shiprocket booking failed — using manual tracking:', srErr.message);
      }
    }

    order.shipping.trackingId         = trackingId;
    order.shipping.carrier            = carrier;
    order.shipping.shippedAt          = new Date();
    order.shipping.shiprocketOrderId  = shiprocketOrderId;

    order.pushStatus(
      'shipped',
      `Shipped via ${carrier}${trackingId ? ` — Tracking: ${trackingId}` : ''}`,
      req.user._id
    );
    await order.save();

    return res.json({
      message:    'Order marked as shipped.',
      trackingId: trackingId || 'Will be updated shortly',
      carrier,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: PATCH /api/orders/:id/admin-forward
// Admin forwards a request_sent order to the artist.
// Status: request_sent → waiting
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/admin-forward', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.status !== 'request_sent') {
      return res.status(400).json({
        message: `Only 'request_sent' orders can be forwarded. Current: "${order.status}".`,
      });
    }

    if (req.body.adminNotes) order.adminNotes = req.body.adminNotes.trim();

    order.pushStatus('waiting', 'Forwarded to artist by admin', req.user._id);
    await order.save();

    return res.json({
      message: 'Order forwarded to artist.',
      status:  order.status,
      orderId: order.orderId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: PATCH /api/orders/:id/admin-ship
// Admin adds tracking information and marks a physical order as shipped.
// Status: completed → shipped
//
// Body: { trackingId: string, carrier?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/admin-ship', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { trackingId, carrier = 'India Post' } = req.body;

    if (!trackingId || !trackingId.trim()) {
      return res.status(400).json({ message: 'trackingId is required.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.deliveryType !== 'physical') {
      return res.status(400).json({ message: 'Shipping is only for physical orders.' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({
        message: `Order must be "completed" to ship. Current: "${order.status}".`,
      });
    }

    order.shipping.trackingId = trackingId.trim();
    order.shipping.carrier    = carrier.trim() || 'India Post';
    order.shipping.shippedAt  = new Date();

    order.pushStatus(
      'shipped',
      `Shipped via ${order.shipping.carrier} — Tracking: ${trackingId.trim()}`,
      req.user._id
    );
    await order.save();

    return res.json({
      message:    'Order marked as shipped. Tracking saved.',
      trackingId: order.shipping.trackingId,
      carrier:    order.shipping.carrier,
      status:     order.status,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: PATCH /api/orders/:id/admin-deliver
// Admin marks an order as delivered.
// Physical: shipped → delivered
// Digital:  completed → delivered (admin approves artwork release)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/admin-deliver', requireRole('admin'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    const allowedFrom = order.deliveryType === 'physical' ? ['shipped'] : ['completed'];
    if (!allowedFrom.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot deliver from status "${order.status}". Expected: "${allowedFrom.join(' or ')}".`,
      });
    }

    // Digital: generate one-time download token on delivery
    if (order.deliveryType === 'digital' && order.artworkFile?.url) {
      order.artworkFile.token     = crypto.randomBytes(32).toString('hex');
      order.artworkFile.tokenUsed = false;
    }

    if (order.deliveryType === 'physical') {
      order.shipping.deliveredAt = new Date();
    }

    order.pushStatus('delivered', 'Marked as delivered by admin', req.user._id);
    await order.save();

    return res.json({
      message: 'Order marked as delivered.',
      status:  order.status,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT: POST /api/orders/:id/pay/advance
// Create a Razorpay order for the 50% advance payment.
// Only callable after artist accepts the order.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/pay/advance', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.status !== 'accepted') {
      return res.status(400).json({
        message: `Advance payment only available after artist accepts. Current: "${order.status}".`,
      });
    }
    if (order.payment.advancePaid) {
      return res.status(400).json({ message: 'Advance payment already completed.' });
    }

    const rzpOrder = await razorpay.orders.create({
      amount:   toPaise(order.pricing.advanceAmount),
      currency: 'INR',
      receipt:  `ADV-${order._id.toString().slice(-8)}`,
      notes: {
        zorvexOrderId: order._id.toString(),
        zorvexOrderRef: order.orderId,
        paymentType:   'advance',
        buyerEmail:    req.user.email,
      },
    });

    order.payment.razorpayOrderId = rzpOrder.id;
    await order.save();

    return res.json({
      razorpayOrderId: rzpOrder.id,
      amount:          rzpOrder.amount,
      currency:        rzpOrder.currency,
      key:             process.env.RAZORPAY_KEY_ID,
      orderRef:        order.orderId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT: POST /api/orders/:id/pay/advance/verify
// Verify Razorpay signature for the advance payment.
// Status: accepted → advance_paid
//
// Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/pay/advance/verify', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.payment.advancePaid) {
      return res.status(400).json({ message: 'Advance already verified.' });
    }

    const isValid = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
      return res.status(400).json({ message: 'Payment signature verification failed. Please contact support.' });
    }

    order.payment.advancePaid       = true;
    order.payment.advancePaidAt     = new Date();
    order.payment.razorpayPaymentId = razorpayPaymentId;
    order.cancelLocked              = true;

    order.pushStatus('advance_paid', 'Advance payment received', req.user._id);
    await order.save();

    return res.json({ message: 'Advance payment verified. Artist will begin work shortly.' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT: POST /api/orders/:id/pay/final
// Create a Razorpay order for the remaining 50% final payment.
// Only callable after artwork is completed.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/pay/final', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({
        message: `Final payment only available after artwork is completed. Current: "${order.status}".`,
      });
    }
    if (order.payment.fullPaid) {
      return res.status(400).json({ message: 'Final payment already completed.' });
    }

    const rzpOrder = await razorpay.orders.create({
      amount:   toPaise(order.pricing.remainingAmount),
      currency: 'INR',
      receipt:  `FIN-${order._id.toString().slice(-8)}`,
      notes: {
        zorvexOrderId:  order._id.toString(),
        zorvexOrderRef: order.orderId,
        paymentType:    'final',
        buyerEmail:     req.user.email,
      },
    });

    order.payment.razorpayOrderId = rzpOrder.id;
    await order.save();

    return res.json({
      razorpayOrderId: rzpOrder.id,
      amount:          rzpOrder.amount,
      currency:        rzpOrder.currency,
      key:             process.env.RAZORPAY_KEY_ID,
      orderRef:        order.orderId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT: POST /api/orders/:id/pay/final/verify
// Verify Razorpay signature for the final payment.
//
// Body: { razorpayOrderId, razorpayPaymentId, razorpaySignature }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:id/pay/final/verify', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.payment.fullPaid) {
      return res.status(400).json({ message: 'Final payment already verified.' });
    }

    const isValid = verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!isValid) {
      return res.status(400).json({ message: 'Payment signature verification failed. Please contact support.' });
    }

    order.payment.fullPaid          = true;
    order.payment.fullPaidAt        = new Date();
    order.payment.razorpayPaymentId = razorpayPaymentId;

    order.pushStatus('completed', 'Final payment received — artwork ready for delivery', req.user._id);
    await order.save();

    return res.json({ message: 'Final payment verified. Your artwork is on its way!' });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DIGITAL: GET /api/orders/:id/download
// One-time secure artwork download link. Buyer only, after full payment.
// The token is consumed on first use — the URL cannot be re-downloaded.
//
// Query: token — the one-time download token
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/download', requireRole('buyer'), async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { token } = req.query;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }
    if (order.deliveryType !== 'digital') {
      return res.status(400).json({ message: 'This is not a digital order.' });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({ message: 'Artwork is not yet available for download.' });
    }
    if (!order.artworkFile?.url) {
      return res.status(404).json({ message: 'Artwork file not found. Please contact support.' });
    }
    if (!token) {
      return res.status(400).json({ message: 'Download token is required.' });
    }
    if (order.artworkFile.token !== token) {
      return res.status(401).json({ message: 'Invalid download token.' });
    }
    if (order.artworkFile.tokenUsed) {
      return res.status(410).json({
        message: 'This download link has already been used. Contact support if you need another copy.',
      });
    }

    // Consume the token — one-time use
    order.artworkFile.tokenUsed = true;
    order.artworkFile.viewedAt  = new Date();
    order.artworkFile.viewed    = true;
    await order.save();

    return res.json({
      message:     'Download token validated. Use this URL immediately.',
      downloadUrl: order.artworkFile.url,
      viewedAt:    order.artworkFile.viewedAt,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: GET /api/orders/:id/tracking
// Live Shiprocket tracking. Buyer and artist can both view.
// Phase 5 fix: uses populate() so assertOrderAccess works correctly.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/tracking', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    // Phase 5 fix: use populate() for buyer/_id and artist/_id
    // so assertOrderAccess can compare ObjectId strings reliably
    const order = await Order.findById(req.params.id)
      .populate('buyer',  '_id')
      .populate('artist', '_id')
      .select('buyer artist shipping deliveryType status');

    if (!order) return res.status(404).json({ message: 'Order not found.' });

    try {
      assertOrderAccess(order, req.user);
    } catch (accessErr) {
      return res.status(403).json({ message: accessErr.message });
    }

    if (order.deliveryType !== 'physical') {
      return res.status(400).json({ message: 'Tracking is only available for physical orders.' });
    }
    if (!order.shipping?.shiprocketOrderId && !order.shipping?.trackingId) {
      return res.status(404).json({ message: 'No tracking information available yet.' });
    }

    let tracking = {
      carrier:    order.shipping.carrier,
      trackingId: order.shipping.trackingId,
      shippedAt:  order.shipping.shippedAt,
      status:     order.status,
    };

    if (order.shipping.shiprocketOrderId) {
      try {
        const liveData = await getTrackingDetails(order.shipping.shiprocketOrderId);
        tracking = { ...tracking, liveData };
      } catch (trackErr) {
        console.warn('Live tracking fetch failed:', trackErr.message);
        // Return cached data — don't fail the request
      }
    }

    return res.json({ tracking });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
