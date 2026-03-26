const express = require("express");
const router = express.Router();
const Order = require("../models/Order");
const ArtistProfile = require("../models/ArtistProfile");
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");
const { calculateDeliveryFee } = require("../utils/delivery");
const {
  sendOrderConfirmation,
  sendOrderAccepted,
  sendShippingUpdate,
  sendPickupRequest,
} = require("../utils/email");

// ─── COMMISSION_RATE: 10% of base price ───────────────────────────────────
const COMMISSION_RATE = 0.10;

// ─── Helper: status transition guard ──────────────────────────────────────
const ALLOWED_TRANSITIONS = {
  request_sent: ["waiting", "rejected"],
  waiting:      ["accepted", "rejected"],
  accepted:     ["advance_paid", "rejected"],
  advance_paid: ["in_progress"],
  in_progress:  ["completed"],
  completed:    ["shipped", "delivered"],
  shipped:      ["delivered"],
  delivered:    [],
  rejected:     [],
};

const canTransition = (from, to) =>
  (ALLOWED_TRANSITIONS[from] || []).includes(to);

// ════════════════════════════════════════════════════════════════════════════
// BUYER ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ─── POST /api/orders — create commission request ─────────────────────────
router.post("/", protect, restrictTo("buyer"), async (req, res) => {
  try {
    const {
      artistProfileId,
      category,
      subcategory,
      pricingTierId,
      description,
      deadline,
      deliveryType,
      referenceImageUrl,
      deliveryAddress,
      buyerPhone,
    } = req.body;

    // Validate required fields
    if (!artistProfileId || !category || !description || !deadline || !deliveryType) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: artistProfileId, category, description, deadline, deliveryType",
      });
    }

    // Find artist profile — ensures artist exists
    const artistProfile = await ArtistProfile.findById(artistProfileId).populate("user");
    if (!artistProfile) {
      return res.status(404).json({ success: false, message: "Artist not found." });
    }

    if (artistProfile.availability === "closed") {
      return res.status(400).json({
        success: false,
        message: "This artist is not currently accepting commissions.",
      });
    }

    // ── Fetch pricing from artist's profile tier ──
    let basePrice = 0;
    let tierName = category;

    if (pricingTierId) {
      const tier = artistProfile.pricingTiers.id(pricingTierId);
      if (tier) {
        basePrice = tier.price;
        tierName = tier.name;
      }
    }

    if (!basePrice) {
      // Fallback: use lowest tier price
      if (artistProfile.pricingTiers.length > 0) {
        const lowest = artistProfile.pricingTiers.reduce((a, b) =>
          a.price < b.price ? a : b
        );
        basePrice = lowest.price;
        tierName = lowest.name;
      } else {
        return res.status(400).json({
          success: false,
          message: "This artist has not set up pricing yet.",
        });
      }
    }

    // ── Calculate delivery fee ──
    let deliveryFee = 0;
    if (deliveryType === "physical" && deliveryAddress?.pincode) {
      const artistPincode = artistProfile.location?.pincode || "673001";
      const result = await calculateDeliveryFee(deliveryAddress.pincode, artistPincode);
      deliveryFee = result.fee;
    }

    const commission = Math.round(basePrice * COMMISSION_RATE);
    const total = basePrice + commission + deliveryFee;
    const advance = Math.round(total * 0.5);

    // ── Create order ──
    const order = await Order.create({
      buyer: req.user._id,
      artist: artistProfile._id,
      category,
      subcategory: subcategory || "",
      pricingTierId: pricingTierId || null,
      pricingTierName: tierName,
      description,
      deadline: new Date(deadline),
      deliveryType,
      referenceImageUrl: referenceImageUrl || "",
      deliveryAddress: deliveryType === "physical" ? deliveryAddress : undefined,
      buyerPhone: buyerPhone || req.user.phone,
      pricing: {
        basePrice,
        platformCommission: commission,
        deliveryFee,
        total,
        advance,
        remaining: advance, // remaining = advance until fully paid
      },
    });

    // Send confirmation email (non-blocking)
    sendOrderConfirmation(order, req.user, artistProfile).catch(console.error);

    res.status(201).json({ success: true, order });
  } catch (err) {
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors).map((e) => e.message)[0];
      return res.status(400).json({ success: false, message: msg });
    }
    console.error("Create order error:", err);
    res.status(500).json({ success: false, message: "Could not create order." });
  }
});

// ─── GET /api/orders/my — buyer's own orders ──────────────────────────────
router.get("/my", protect, restrictTo("buyer"), async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { buyer: req.user._id };
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate("artist", "displayName avatarUrl avgRating location")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    res.json({ success: true, total, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/orders/delivery-fee — estimate before placing order ─────────
router.get("/delivery-fee", protect, async (req, res) => {
  try {
    const { buyerPincode, artistId } = req.query;
    if (!buyerPincode || !artistId) {
      return res.status(400).json({ success: false, message: "buyerPincode and artistId required." });
    }

    const profile = await ArtistProfile.findById(artistId).select("location");
    if (!profile) return res.status(404).json({ success: false, message: "Artist not found." });

    const artistPincode = profile.location?.pincode || "673001";
    const result = await calculateDeliveryFee(buyerPincode, artistPincode);

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/orders/:id — single order (buyer or artist or admin) ─────────
router.get("/:id", protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("buyer", "name email")
      .populate({
        path: "artist",
        populate: { path: "user", select: "name email" },
      });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Access control
    const isBuyer = order.buyer._id.toString() === req.user._id.toString();
    const isArtist =
      req.user.role === "artist" &&
      order.artist.user._id.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isBuyer && !isArtist && !isAdmin) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    // Strip delivery address and buyer phone from artist view
    const data = order.toObject();
    if (isArtist) {
      delete data.deliveryAddress;
      delete data.buyerPhone;
    }

    res.json({ success: true, order: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/pay-advance — buyer confirms advance payment ───
router.patch("/:id/pay-advance", protect, restrictTo("buyer"), async (req, res) => {
  try {
    const { paymentId } = req.body;
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }
    if (order.status !== "accepted") {
      return res.status(400).json({ success: false, message: "Order must be accepted before payment." });
    }

    order.status = "advance_paid";
    order.advancePaid = true;
    order.advancePaidAt = new Date();
    order.paymentId = paymentId || "rzp_mock_" + Date.now();
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ARTIST ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /api/orders/artist/mine — artist's assigned orders ──────────────
router.get("/artist/mine", protect, restrictTo("artist"), async (req, res) => {
  try {
    const profile = await ArtistProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ success: false, message: "Artist profile not found." });
    }

    const { status, page = 1, limit = 20 } = req.query;
    const filter = { artist: profile._id };
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate("buyer", "name")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Strip sensitive buyer info
    const cleaned = orders.map((o) => {
      const obj = o.toObject();
      delete obj.deliveryAddress;
      delete obj.buyerPhone;
      return obj;
    });

    res.json({ success: true, total, orders: cleaned });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/artist-action — accept or reject ──────────────
router.patch("/:id/artist-action", protect, restrictTo("artist"), async (req, res) => {
  try {
    const { action, reason } = req.body; // action: "accept" | "reject"
    const profile = await ArtistProfile.findOne({ user: req.user._id });
    const order = await Order.findById(req.params.id).populate("buyer");

    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.artist.toString() !== profile._id.toString()) {
      return res.status(403).json({ success: false, message: "Not your order." });
    }
    if (order.status !== "waiting") {
      return res.status(400).json({
        success: false,
        message: "Can only respond to orders in 'waiting' status.",
      });
    }

    if (action === "accept") {
      order.status = "accepted";
      await order.save();
      sendOrderAccepted(order, order.buyer).catch(console.error);
      return res.json({ success: true, message: "Order accepted.", order });
    }

    if (action === "reject") {
      order.status = "rejected";
      order.rejectionReason = reason || "Artist unavailable or declined request.";
      await order.save();
      return res.json({ success: true, message: "Order declined.", order });
    }

    res.status(400).json({ success: false, message: "Action must be 'accept' or 'reject'." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/start — artist starts work ────────────────────
router.patch("/:id/start", protect, restrictTo("artist"), async (req, res) => {
  try {
    const profile = await ArtistProfile.findOne({ user: req.user._id });
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.artist.toString() !== profile._id.toString()) {
      return res.status(403).json({ success: false, message: "Not your order." });
    }
    if (!canTransition(order.status, "in_progress")) {
      return res.status(400).json({
        success: false,
        message: `Cannot move from '${order.status}' to 'in_progress'.`,
      });
    }

    order.status = "in_progress";
    await order.save();
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/complete — artist uploads finished artwork ─────
router.patch("/:id/complete", protect, restrictTo("artist"), async (req, res) => {
  try {
    const { artworkFileUrl } = req.body;
    const profile = await ArtistProfile.findOne({ user: req.user._id }).populate("user");
    const order = await Order.findById(req.params.id);

    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.artist.toString() !== profile._id.toString()) {
      return res.status(403).json({ success: false, message: "Not your order." });
    }
    if (!canTransition(order.status, "completed")) {
      return res.status(400).json({
        success: false,
        message: "Order must be in_progress to mark as completed.",
      });
    }

    order.status = "completed";
    order.artworkFileUrl = artworkFileUrl || "";
    order.artworkUploadedAt = new Date();

    // Auto-capture artist location for pickup
    order.pickupLocation = {
      city: profile.location?.city,
      state: profile.location?.state,
      pincode: profile.location?.pincode,
      fullAddress: profile.location?.fullAddress,
      requestedAt: new Date(),
    };

    await order.save();

    // Notify admin for pickup (non-blocking)
    sendPickupRequest(order, profile, profile.user).catch(console.error);

    // Update artist completed orders count
    await ArtistProfile.findByIdAndUpdate(profile._id, {
      $inc: { completedOrders: 1 },
    });

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ─── GET /api/orders/admin/all — all orders ───────────────────────────────
router.get("/admin/all", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .populate("buyer", "name email phone")
      .populate({
        path: "artist",
        populate: { path: "user", select: "name email phone" },
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    res.json({ success: true, total, orders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/admin-forward — forward to artist ─────────────
router.patch("/:id/admin-forward", protect, restrictTo("admin"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    if (!canTransition(order.status, "waiting")) {
      return res.status(400).json({
        success: false,
        message: `Cannot forward order in '${order.status}' status.`,
      });
    }

    // IMPORTANT: order.artist is already set from when buyer placed the order
    // Admin is just moving it from request_sent → waiting (forwarding to that specific artist)
    order.status = "waiting";
    order.adminNotes = req.body.adminNotes || "";
    await order.save();

    res.json({ success: true, message: "Order forwarded to artist.", order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/admin-ship — add tracking ID ──────────────────
router.patch("/:id/admin-ship", protect, restrictTo("admin"), async (req, res) => {
  try {
    const { trackingId } = req.body;
    if (!trackingId) {
      return res.status(400).json({ success: false, message: "trackingId is required." });
    }

    const order = await Order.findById(req.params.id).populate("buyer");
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    if (!canTransition(order.status, "shipped")) {
      return res.status(400).json({
        success: false,
        message: "Order must be completed before shipping.",
      });
    }

    order.status = "shipped";
    order.trackingId = trackingId;
    order.shippedAt = new Date();
    await order.save();

    sendShippingUpdate(order, order.buyer).catch(console.error);

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/orders/:id/admin-deliver — mark delivered ────────────────
router.patch("/:id/admin-deliver", protect, restrictTo("admin"), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });

    order.status = "delivered";
    order.deliveredAt = new Date();
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/orders/admin/stats — dashboard stats ────────────────────────
router.get("/admin/stats", protect, restrictTo("admin"), async (req, res) => {
  try {
    const [statusCounts, revenueData, userCount] = await Promise.all([
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.aggregate([
        {
          $match: {
            status: {
              $in: ["advance_paid", "in_progress", "completed", "shipped", "delivered"],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$pricing.total" },
            totalCommission: { $sum: "$pricing.platformCommission" },
            totalOrders: { $sum: 1 },
          },
        },
      ]),
      User.countDocuments(),
    ]);

    const statusMap = {};
    statusCounts.forEach((s) => { statusMap[s._id] = s.count; });

    res.json({
      success: true,
      stats: {
        statusCounts: statusMap,
        revenue: revenueData[0] || { totalRevenue: 0, totalCommission: 0, totalOrders: 0 },
        totalUsers: userCount,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
