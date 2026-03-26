const express = require("express");
const router = express.Router();
const User = require("../models/User");
const ArtistProfile = require("../models/ArtistProfile");
const Order = require("../models/Order");
const Review = require("../models/Review");
const { protect, restrictTo } = require("../middleware/auth");

// All routes here require admin role
router.use(protect, restrictTo("admin"));

// ─── GET /api/admin/dashboard — full stats ────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const [
      totalUsers,
      totalArtists,
      totalBuyers,
      orderStats,
      revenueStats,
      recentOrders,
      pendingForward,
      readyToShip,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "artist" }),
      User.countDocuments({ role: "buyer" }),
      Order.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      Order.aggregate([
        {
          $match: {
            status: { $in: ["advance_paid","in_progress","completed","shipped","delivered"] },
          },
        },
        {
          $group: {
            _id: null,
            grossRevenue: { $sum: "$pricing.total" },
            platformCommission: { $sum: "$pricing.platformCommission" },
            deliveryCollected: { $sum: "$pricing.deliveryFee" },
            orderCount: { $sum: 1 },
          },
        },
      ]),
      Order.find().sort({ createdAt: -1 }).limit(10)
        .populate("buyer", "name email")
        .populate({ path: "artist", populate: { path: "user", select: "name" } }),
      Order.countDocuments({ status: "request_sent" }),
      Order.countDocuments({ status: "completed", deliveryType: "physical" }),
    ]);

    const statusMap = {};
    orderStats.forEach((s) => { statusMap[s._id] = s.count; });

    res.json({
      success: true,
      dashboard: {
        users: { total: totalUsers, artists: totalArtists, buyers: totalBuyers },
        orders: statusMap,
        revenue: revenueStats[0] || {
          grossRevenue: 0, platformCommission: 0, deliveryCollected: 0, orderCount: 0,
        },
        alerts: { pendingForward, readyToShip },
        recentOrders,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/admin/users — list all users ────────────────────────────────
router.get("/users", async (req, res) => {
  try {
    const { role, page = 1, limit = 30, search } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const total = await User.countDocuments(filter);
    const users = await User.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    res.json({ success: true, total, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/admin/users/:id/deactivate — toggle user active state ─────
router.patch("/users/:id/deactivate", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.role === "admin") {
      return res.status(400).json({ success: false, message: "Cannot deactivate admin account." });
    }
    user.isActive = !user.isActive;
    await user.save();
    res.json({
      success: true,
      message: `User ${user.isActive ? "activated" : "deactivated"}.`,
      user,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/admin/artists/:profileId/verify — verify an artist ────────
router.patch("/artists/:profileId/verify", async (req, res) => {
  try {
    const profile = await ArtistProfile.findByIdAndUpdate(
      req.params.profileId,
      { isVerified: true, isFeatured: req.body.feature === true },
      { new: true }
    );
    if (!profile) return res.status(404).json({ success: false, message: "Profile not found." });
    res.json({ success: true, profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/admin/artists/unverified — artists awaiting verification ─────
router.get("/artists/unverified", async (req, res) => {
  try {
    const profiles = await ArtistProfile.find({ isVerified: false })
      .populate("user", "name email phone createdAt");
    res.json({ success: true, profiles });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/admin/seed — seed admin user (run once) ───────────────────
router.post("/seed-admin", async (req, res) => {
  try {
    const existing = await User.findOne({ role: "admin" });
    if (existing) {
      return res.status(400).json({ success: false, message: "Admin already seeded." });
    }
    const admin = await User.create({
      name: "ZorvEx Admin",
      email: "zorvexinfo@gmail.com",
      phone: "9946301939",
      password: "Zorvex@2025",  // Capital Z, has numbers — passes regex
      role: "admin",
    });
    res.status(201).json({ success: true, message: "Admin user created.", admin });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
