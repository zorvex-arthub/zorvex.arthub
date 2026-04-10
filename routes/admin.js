/**
 * routes/admin.js
 *
 * All admin-only endpoints for the ZorvEx Admin Control Center.
 * Every route in this file is protected by adminOnly middleware.
 *
 * Endpoints:
 *
 *   DASHBOARD
 *   GET  /api/admin/dashboard               — KPI stats (users, orders, revenue)
 *
 *   USER MANAGEMENT
 *   GET  /api/admin/users                   — List all users (search, role filter)
 *   GET  /api/admin/users/:id               — Get a single user's full profile
 *   PATCH /api/admin/users/:id/deactivate   — Toggle user isActive (activate/deactivate)
 *
 *   ARTIST VERIFICATION
 *   GET  /api/admin/artists/unverified      — List unverified artist profiles
 *   PATCH /api/admin/artists/:profileId/verify — Verify (and optionally feature) an artist
 *
 *   BLACKLIST
 *   POST   /api/admin/blacklist             — Add a user/email/phone/IP to blacklist
 *   GET    /api/admin/blacklist             — List active blacklist entries
 *   DELETE /api/admin/blacklist/:id         — Deactivate (soft-delete) a blacklist entry
 *
 *   CHAT OVERSIGHT (mandatory feature: admin reads all chats)
 *   GET  /api/admin/chats                   — List all order chat threads
 *   GET  /api/admin/chats/:orderId          — Read a specific order's full chat
 *
 *   REPORTS
 *   POST  /api/admin/reports                — Submit a report (any authenticated user)
 *   GET   /api/admin/reports                — List all reports (admin only)
 *   PATCH /api/admin/reports/:id/resolve    — Resolve a report
 *
 *   ORDER MANAGEMENT (admin actions on orders)
 *   GET   /api/admin/orders                 — All orders with filters + pagination
 *   GET   /api/admin/orders/stats           — Order stats for dashboard KPIs
 *   PATCH /api/admin/orders/:id/forward     — Forward request_sent → waiting
 *   PATCH /api/admin/orders/:id/ship        — Add tracking + mark as shipped
 *   PATCH /api/admin/orders/:id/deliver     — Mark as delivered
 *
 *   SEED (dev only — remove in production)
 *   POST /api/admin/seed-admin              — Create admin user if not exists
 */

'use strict';

const express       = require('express');
const mongoose      = require('mongoose');
const User          = require('../models/User');
const ArtistProfile = require('../models/ArtistProfile');
const Order         = require('../models/Order');
const Blacklist     = require('../models/Blacklist');
const Message       = require('../models/Message');
const { protect, requireRole, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// All routes in this file require admin — apply once at the top
router.use(...adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
// REPORT SUB-SCHEMA (in-memory — no separate model needed for MVP)
// Reports are stored on a lightweight model defined inline.
// ─────────────────────────────────────────────────────────────────────────────
// We define the Report model here and guard against re-registration.
let Report;
if (mongoose.models.Report) {
  Report = mongoose.model('Report');
} else {
  const ReportSchema = new mongoose.Schema({
    reporter:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reportedUser:{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reportedOrder:{ type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    reason:      { type: String, required: true, trim: true, maxlength: 2000 },
    category:    {
      type: String,
      enum: ['fraud', 'harassment', 'spam', 'quality', 'payment', 'other'],
      default: 'other',
    },
    status: {
      type:    String,
      enum:    ['open', 'under_review', 'resolved', 'dismissed'],
      default: 'open',
    },
    resolvedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt:   { type: Date, default: null },
    adminNotes:   { type: String, default: null },
  }, { timestamps: true });
  ReportSchema.index({ status: 1, createdAt: -1 });
  ReportSchema.index({ reporter: 1 });
  Report = mongoose.model('Report', ReportSchema);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/dashboard
// Returns KPI stats for the admin overview panel:
//   statusCounts  — count of orders per status
//   revenue       — total platform commission + delivery fees
//   totalUsers    — count of all registered users
//   recentOrders  — last 10 orders (for the recent-orders table)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    // Run all aggregations in parallel for speed
    const [
      orderAgg,
      userCount,
      recentOrders,
    ] = await Promise.all([
      // Order counts per status + revenue rollup
      Order.aggregate([
        {
          $group: {
            _id:             '$status',
            count:           { $sum: 1 },
            totalCommission: { $sum: '$pricing.platformFee' },
            totalDelivery:   { $sum: '$pricing.deliveryFee' },
            totalRevenue:    { $sum: '$pricing.totalAmount' },
          },
        },
      ]),

      // Total registered users
      User.countDocuments({}),

      // 10 most recent orders for the overview table
      Order.find({})
        .populate('buyer',         'name email')
        .populate('artist',        'name')
        .populate('artistProfile', 'displayName avatar')
        .select('orderId category status pricing deliveryType createdAt')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    // Reshape order aggregation into a statusCounts map and totals
    const statusCounts  = {};
    let totalCommission = 0;
    let totalDelivery   = 0;
    let totalRevenue    = 0;

    for (const row of orderAgg) {
      statusCounts[row._id] = row.count;
      totalCommission += row.totalCommission || 0;
      totalDelivery   += row.totalDelivery   || 0;
      totalRevenue    += row.totalRevenue    || 0;
    }

    return res.json({
      stats: {
        statusCounts,
        revenue: {
          totalCommission: Math.round(totalCommission),
          totalDeliveryFees: Math.round(totalDelivery),
          totalRevenue:    Math.round(totalRevenue),
        },
        totalUsers: userCount,
      },
      recentOrders,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/users
// List all users with optional filters.
//
// Query params:
//   role     — 'buyer' | 'artist' | 'admin'
//   search   — partial match on name or email
//   page     — page number (default 1)
//   limit    — results per page (default 50, max 200)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res, next) => {
  try {
    const {
      role,
      search,
      page  = 1,
      limit = 50,
    } = req.query;

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip     = (pageNum - 1) * limitNum;

    const filter = {};

    if (role && ['buyer', 'artist', 'admin'].includes(role)) {
      filter.role = role;
    }

    if (search && search.trim()) {
      const regex = new RegExp(
        search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i'
      );
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password -phoneOtp -googleId -firebaseUid')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    return res.json({
      users,
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
// GET /api/admin/users/:id
// Full profile for a single user — includes their order count and, for
// artists, their ArtistProfile.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/users/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID.' });
    }

    const [user, orderCount, blacklistEntry] = await Promise.all([
      User.findById(req.params.id)
        .select('-password -phoneOtp -googleId -firebaseUid')
        .populate('artistProfile')
        .lean(),
      Order.countDocuments({
        $or: [{ buyer: req.params.id }, { artist: req.params.id }],
      }),
      Blacklist.findOne({ type: 'user', userId: req.params.id, isActive: true }),
    ]);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.json({
      user,
      orderCount,
      isBlacklisted: !!blacklistEntry,
      blacklistEntry: blacklistEntry || null,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/deactivate
// Toggle a user's isActive flag.
// Cannot deactivate the admin account itself.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/users/:id/deactivate', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID.' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.role === 'admin') {
      return res.status(403).json({
        message: 'The admin account cannot be deactivated.',
      });
    }

    user.isActive = !user.isActive;
    await user.save();

    return res.json({
      message: user.isActive
        ? 'User account has been activated.'
        : 'User account has been deactivated.',
      isActive: user.isActive,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/artists/unverified
// Returns ArtistProfile documents where admin.isVerified === false,
// with the associated User populated for display in the verification table.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/artists/unverified', async (req, res, next) => {
  try {
    const profiles = await ArtistProfile.find({ 'admin.isVerified': false })
      .populate('user', 'name email createdAt avatar')
      .select('displayName bio avatar pricingTiers portfolio categories stats admin createdAt')
      .sort({ createdAt: 1 })   // oldest first — they've been waiting longest
      .lean();

    return res.json({ profiles });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/artists/:profileId/verify
// Verify an artist and optionally feature them on the browse page.
//
// Body: { feature: boolean }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/artists/:profileId/verify', async (req, res, next) => {
  try {
    if (!isValidId(req.params.profileId)) {
      return res.status(400).json({ message: 'Invalid profile ID.' });
    }

    const { feature = false } = req.body;

    const profile = await ArtistProfile.findByIdAndUpdate(
      req.params.profileId,
      {
        $set: {
          'admin.isVerified': true,
          'admin.isFeatured': !!feature,
          'admin.verifiedAt': new Date(),
          'admin.verifiedBy': req.user._id,
        },
      },
      { new: true }
    ).populate('user', 'name email');

    if (!profile) {
      return res.status(404).json({ message: 'Artist profile not found.' });
    }

    return res.json({
      message: feature
        ? `${profile.displayName || profile.user?.name} has been verified and featured.`
        : `${profile.displayName || profile.user?.name} has been verified.`,
      profile,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/blacklist
// Add a user, email, phone, or IP to the blacklist.
//
// Body:
//   type      — 'user' | 'email' | 'phone' | 'ip'
//   value     — the user ID, email, phone number, or IP address
//   reason    — required explanation for audit trail
//   userId    — optional: link to a User document
//   expiresAt — optional ISO date string for a temporary ban
// ─────────────────────────────────────────────────────────────────────────────
router.post('/blacklist', async (req, res, next) => {
  try {
    const { type, value, reason, userId = null, expiresAt = null } = req.body;

    if (!type || !['user', 'email', 'phone', 'ip'].includes(type)) {
      return res.status(400).json({
        message: "type must be one of: 'user', 'email', 'phone', 'ip'",
      });
    }
    if (!value || !value.toString().trim()) {
      return res.status(400).json({ message: 'value is required.' });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ message: 'reason is required for the audit trail.' });
    }

    // Prevent admin from blacklisting themselves
    if (type === 'user' && value.toString() === req.user._id.toString()) {
      return res.status(403).json({ message: 'You cannot blacklist your own account.' });
    }

    const entry = await Blacklist.create({
      type,
      value:     value.toString().toLowerCase().trim(),
      reason:    reason.trim(),
      userId:    userId || null,
      blockedBy: req.user._id,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive:  true,
    });

    // If blocking a user account, also deactivate their User document
    if (type === 'user' && isValidId(value)) {
      await User.findByIdAndUpdate(value, { isActive: false });
    }

    return res.status(201).json({
      message: `${type} has been blacklisted.`,
      entry,
    });
  } catch (err) {
    // Duplicate blacklist entry
    if (err.code === 11000) {
      return res.status(409).json({
        message: 'This entry is already on the blacklist.',
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/blacklist
// List active blacklist entries.
//
// Query params:
//   type  — filter by type ('user' | 'email' | 'phone' | 'ip')
//   page  — page number (default 1)
//   limit — results per page (default 50)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/blacklist', async (req, res, next) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip     = (pageNum - 1) * limitNum;

    const filter = { isActive: true };
    if (type && ['user', 'email', 'phone', 'ip'].includes(type)) {
      filter.type = type;
    }

    const [entries, total] = await Promise.all([
      Blacklist.find(filter)
        .populate('blockedBy', 'name email')
        .populate('userId',    'name email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Blacklist.countDocuments(filter),
    ]);

    return res.json({
      entries,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/blacklist/:id
// Deactivate (soft-delete) a blacklist entry — does not hard-delete the record
// so the audit trail is preserved.
// Also re-activates the associated User account if the entry was a 'user' type.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/blacklist/:id', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid blacklist entry ID.' });
    }

    const entry = await Blacklist.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!entry) {
      return res.status(404).json({ message: 'Blacklist entry not found.' });
    }

    // Re-activate the User if it was a user-type block
    if (entry.type === 'user' && entry.userId) {
      await User.findByIdAndUpdate(entry.userId, { isActive: true });
    }

    return res.json({
      message: 'Blacklist entry has been lifted. User access restored if applicable.',
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/chats
// List all orders that have at least one chat message — for the admin
// chat oversight panel (Mandatory Feature: admin reads all user-artist chats).
//
// Query params:
//   page  — page number (default 1)
//   limit — results per page (default 20)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/chats', async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip     = (pageNum - 1) * limitNum;

    // Find orders that have messages — aggregate for message counts per order
    const chatSummary = await Message.aggregate([
      { $group: {
          _id:          '$order',
          messageCount: { $sum: 1 },
          lastMessage:  { $last: '$text' },
          lastAt:       { $last: '$createdAt' },
          hasPii:       { $max: { $cond: ['$piiDetected', 1, 0] } },
      }},
      { $sort: { lastAt: -1 } },
      { $skip:  skip },
      { $limit: limitNum },
    ]);

    // Populate order details
    const orderIds = chatSummary.map((c) => c._id);
    const orders   = await Order.find({ _id: { $in: orderIds } })
      .populate('buyer',  'name email')
      .populate('artist', 'name email')
      .select('orderId category status createdAt')
      .lean();

    // Merge order data into summary
    const ordersMap = {};
    orders.forEach((o) => { ordersMap[o._id.toString()] = o; });

    const threads = chatSummary.map((c) => ({
      orderId:      c._id,
      order:        ordersMap[c._id.toString()] || null,
      messageCount: c.messageCount,
      lastMessage:  c.lastMessage,
      lastAt:       c.lastAt,
      hasPii:       c.hasPii === 1,
    }));

    const totalOrders = await Message.distinct('order').then((ids) => ids.length);

    return res.json({
      threads,
      pagination: {
        page:       pageNum,
        limit:      limitNum,
        total:      totalOrders,
        totalPages: Math.ceil(totalOrders / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/chats/:orderId
// Read the complete chat thread for a specific order.
// Admin can read any order's chat regardless of participation.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/chats/:orderId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const [order, messages] = await Promise.all([
      Order.findById(req.params.orderId)
        .populate('buyer',  'name email avatar')
        .populate('artist', 'name email avatar')
        .select('orderId category status createdAt buyer artist')
        .lean(),
      Message.forOrder(req.params.orderId),
    ]);

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    return res.json({ order, messages });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/reports
// Any authenticated user can submit a report.
// Override the adminOnly at top: this one specific route allows any authed user.
// We handle this by using protect directly instead of the adminOnly middleware.
//
// NOTE: This route is mounted under /api/admin but uses `protect` not adminOnly
// so buyers/artists can submit reports. The middleware override is applied
// via a standalone sub-router mounted before the adminOnly guard, but since
// we already applied adminOnly via router.use() above, we'll expose this
// as a public-within-admin route by re-exporting from routes/users.js in a
// future step. For now, we handle it here with a role check bypass via an
// explicit re-application.
//
// PRACTICAL SOLUTION: The report submission route is intentionally moved to
// its own handler that explicitly uses [protect] (not adminOnly):
// ─────────────────────────────────────────────────────────────────────────────

// Create a sub-router for report submission that only needs protect (not admin)
const reportRouter = express.Router();
reportRouter.use(protect);

reportRouter.post('/', async (req, res, next) => {
  try {
    const { reason, category, reportedUserId, reportedOrderId } = req.body;

    if (!reason || !reason.trim() || reason.trim().length < 10) {
      return res.status(400).json({
        message: 'Reason is required and must be at least 10 characters.',
      });
    }

    if (reportedUserId && !isValidId(reportedUserId)) {
      return res.status(400).json({ message: 'Invalid reportedUserId.' });
    }
    if (reportedOrderId && !isValidId(reportedOrderId)) {
      return res.status(400).json({ message: 'Invalid reportedOrderId.' });
    }

    const report = await Report.create({
      reporter:      req.user._id,
      reportedUser:  reportedUserId  || null,
      reportedOrder: reportedOrderId || null,
      reason:        reason.trim(),
      category:      category || 'other',
    });

    return res.status(201).json({
      message: 'Your report has been submitted and will be reviewed by our team.',
      reportId: report._id,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/reports
// List all reports — admin only.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reports', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip     = (pageNum - 1) * limitNum;

    const filter = {};
    if (status && ['open', 'under_review', 'resolved', 'dismissed'].includes(status)) {
      filter.status = status;
    } else {
      // Default: show open and under_review reports
      filter.status = { $in: ['open', 'under_review'] };
    }

    const [reports, total] = await Promise.all([
      Report.find(filter)
        .populate('reporter',      'name email')
        .populate('reportedUser',  'name email role')
        .populate('reportedOrder', 'orderId category status')
        .populate('resolvedBy',    'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Report.countDocuments(filter),
    ]);

    return res.json({
      reports,
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
// PATCH /api/admin/reports/:id/resolve
// Resolve or dismiss a report.
//
// Body: { status: 'resolved' | 'dismissed', adminNotes: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/reports/:id/resolve', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid report ID.' });
    }

    const { status = 'resolved', adminNotes = '' } = req.body;

    if (!['resolved', 'dismissed', 'under_review'].includes(status)) {
      return res.status(400).json({
        message: "status must be 'resolved', 'dismissed', or 'under_review'",
      });
    }

    const report = await Report.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          status,
          adminNotes:  adminNotes || null,
          resolvedBy:  ['resolved', 'dismissed'].includes(status) ? req.user._id : null,
          resolvedAt:  ['resolved', 'dismissed'].includes(status) ? new Date() : null,
        },
      },
      { new: true }
    ).populate('reporter', 'name email');

    if (!report) {
      return res.status(404).json({ message: 'Report not found.' });
    }

    return res.json({
      message: `Report has been marked as ${status}.`,
      report,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/orders
// All orders with optional status filter and pagination.
// Used by: All Orders tab, Active Orders tab, Shipping tab in admin dashboard.
//
// Query params:
//   status — filter by order status
//   page   — page number (default 1)
//   limit  — results per page (default 25, max 100)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/orders', async (req, res, next) => {
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
      // Support comma-separated status values: ?status=completed,shipped
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
// GET /api/admin/orders/stats
// Order statistics for the admin dashboard KPI cards.
// Returns status counts + revenue totals.
// (Mirrors the /dashboard endpoint but returns only the stats object,
//  without the recentOrders — for cases where the UI only needs stats.)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/orders/stats', async (req, res, next) => {
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
          totalCommission: Math.round(totalCommission),
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
// PATCH /api/admin/orders/:id/forward
// Admin forwards a request_sent order to the artist.
// Status: request_sent → waiting
//
// Body: { adminNotes: string } (optional)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/orders/:id/forward', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.status !== 'request_sent') {
      return res.status(400).json({
        message: `Only 'request_sent' orders can be forwarded. Current status: "${order.status}".`,
      });
    }

    if (req.body.adminNotes) {
      order.adminNotes = req.body.adminNotes.trim();
    }

    order.pushStatus('waiting', 'Forwarded to artist by admin', req.user._id);
    await order.save();

    return res.json({
      message: 'Order forwarded to artist. Status updated to "Waiting".',
      orderId: order.orderId,
      status:  order.status,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/orders/:id/ship
// Admin adds tracking information and marks a physical order as shipped.
// Status: completed → shipped
//
// Body: { trackingId: string, carrier?: string }
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/orders/:id/ship', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { trackingId, carrier = 'India Post' } = req.body;

    if (!trackingId || !trackingId.trim()) {
      return res.status(400).json({ message: 'trackingId is required.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.deliveryType !== 'physical') {
      return res.status(400).json({
        message: 'Shipping tracking is only applicable to physical orders.',
      });
    }

    if (order.status !== 'completed') {
      return res.status(400).json({
        message: `Order must be in "completed" status to ship. Current: "${order.status}".`,
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
      message:    'Order marked as shipped. Tracking information saved.',
      trackingId: order.shipping.trackingId,
      carrier:    order.shipping.carrier,
      status:     order.status,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/orders/:id/deliver
// Admin marks an order as delivered (physical) or releases digital artwork.
// Status: shipped → delivered  (physical)
//         completed → delivered (digital — admin approves artwork)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/orders/:id/deliver', async (req, res, next) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    const allowedFrom = order.deliveryType === 'physical'
      ? ['shipped']
      : ['completed'];

    if (!allowedFrom.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot mark as delivered. Expected status: "${allowedFrom.join(' or ')}". Current: "${order.status}".`,
      });
    }

    // For digital orders: generate a one-time download token on delivery
    if (order.deliveryType === 'digital' && order.artworkFile?.url) {
      const crypto = require('crypto');
      order.artworkFile.token    = crypto.randomBytes(32).toString('hex');
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
// POST /api/admin/seed-admin
// One-time admin seeding — creates the zorvexinfo@gmail.com admin user if it
// doesn't exist. REMOVE THIS ROUTE IN PRODUCTION after first run.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/seed-admin', async (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({
      message: 'Seed endpoint is disabled in production.',
    });
  }

  try {
    const ADMIN_EMAIL = 'zorvexinfo@gmail.com';
    let existing = await User.findOne({ email: ADMIN_EMAIL });

    if (existing) {
      return res.json({
        message: 'Admin user already exists.',
        userId:  existing._id,
      });
    }

    const adminUser = await User.create({
      name:          'ZorvEx Admin',
      email:         ADMIN_EMAIL,
      password:      'Zorvex@Admin1',  // change immediately after seeding
      role:          'admin',
      phoneVerified: true,
      isVerified:    true,
    });

    return res.status(201).json({
      message: 'Admin user created. Change the password immediately.',
      userId:  adminUser._id,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MOUNT the report submission sub-router (accessible to all authenticated users)
// This is intentionally AFTER the adminOnly router.use() so the path
// /api/admin/reports POST is handled by the protect-only sub-router.
// We export both and mount them separately in server.js.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;

// Also export the report submission handler so server.js can mount it
// on a non-admin path if needed. For now it's embedded above.
module.exports.reportRouter = reportRouter;
