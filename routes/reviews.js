const express = require("express");
const router = express.Router();
const Review = require("../models/Review");
const Order = require("../models/Order");
const ArtistProfile = require("../models/ArtistProfile");
const { protect, restrictTo } = require("../middleware/auth");

// ─── GET /api/reviews/artist/:profileId — public reviews for an artist ────
router.get("/artist/:profileId", async (req, res) => {
  try {
    const reviews = await Review.find({
      artist: req.params.profileId,
      isVisible: true,
    })
      .populate("buyer", "name")
      .sort({ createdAt: -1 })
      .limit(20);

    res.json({ success: true, reviews });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/reviews — submit a review (buyer only) ─────────────────────
// RULE: Buyer can ONLY review if there is a DELIVERED order with that artist
router.post("/", protect, restrictTo("buyer"), async (req, res) => {
  try {
    const { orderId, rating, text, tag } = req.body;

    if (!orderId || !rating || !text) {
      return res.status(400).json({
        success: false,
        message: "orderId, rating, and text are required.",
      });
    }

    // ── Verify the order exists, belongs to this buyer, and is delivered ──
    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    if (order.buyer.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only review your own orders.",
      });
    }

    if (order.status !== "delivered") {
      return res.status(400).json({
        success: false,
        message: "You can only leave a review after your order has been delivered.",
      });
    }

    // ── Check for duplicate review on same order ──
    const existing = await Review.findOne({ order: orderId });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this order.",
      });
    }

    // ── Create review ──
    const review = await Review.create({
      artist: order.artist,
      buyer: req.user._id,
      order: orderId,
      rating: Number(rating),
      text: text.trim(),
      tag: tag?.trim() || "",
    });

    // recalcRating is triggered by the post-save hook in Review model
    const populated = await review.populate("buyer", "name");

    res.status(201).json({ success: true, review: populated });
  } catch (err) {
    if (err.name === "ValidationError") {
      const msg = Object.values(err.errors).map((e) => e.message)[0];
      return res.status(400).json({ success: false, message: msg });
    }
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "You have already reviewed this order.",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/reviews/eligible — orders buyer can review ──────────────────
// Returns delivered orders that don't yet have a review
router.get("/eligible", protect, restrictTo("buyer"), async (req, res) => {
  try {
    // All delivered orders for this buyer
    const deliveredOrders = await Order.find({
      buyer: req.user._id,
      status: "delivered",
    }).populate({ path: "artist", select: "displayName avatarUrl" });

    // Find which ones already have reviews
    const reviewedOrderIds = await Review.find({
      buyer: req.user._id,
    }).distinct("order");

    const reviewedSet = new Set(reviewedOrderIds.map((id) => id.toString()));

    const eligible = deliveredOrders.filter(
      (o) => !reviewedSet.has(o._id.toString())
    );

    res.json({ success: true, eligibleOrders: eligible });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/reviews/:id — admin can hide a review ───────────────────
router.patch("/:id/hide", protect, restrictTo("admin"), async (req, res) => {
  try {
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { isVisible: false },
      { new: true }
    );
    if (!review) return res.status(404).json({ success: false, message: "Review not found." });
    res.json({ success: true, review });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
