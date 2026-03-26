const express = require("express");
const router = express.Router();
const ChatMessage = require("../models/ChatMessage");
const Order = require("../models/Order");
const ArtistProfile = require("../models/ArtistProfile");
const { protect } = require("../middleware/auth");
const { filterChatMessage } = require("../middleware/piiFilter");

// ─── Helper: verify user has access to this order's chat ──────────────────
const verifyOrderAccess = async (orderId, user) => {
  const order = await Order.findById(orderId).populate({
    path: "artist",
    populate: { path: "user", select: "_id" },
  });

  if (!order) return { error: "Order not found.", code: 404 };

  const isBuyer = order.buyer.toString() === user._id.toString();
  const isArtist =
    user.role === "artist" &&
    order.artist?.user?._id.toString() === user._id.toString();
  const isAdmin = user.role === "admin";

  if (!isBuyer && !isArtist && !isAdmin) {
    return { error: "You are not part of this order.", code: 403 };
  }

  // Chat only available after order is accepted
  const chatAllowed = [
    "accepted", "advance_paid", "in_progress", "completed", "shipped", "delivered",
  ].includes(order.status);

  if (!chatAllowed && !isAdmin) {
    return { error: "Chat is only available after the artist accepts the commission.", code: 400 };
  }

  return { order, isBuyer, isArtist, isAdmin };
};

// ─── GET /api/chat/:orderId — load all messages for an order ──────────────
router.get("/:orderId", protect, async (req, res) => {
  try {
    const access = await verifyOrderAccess(req.params.orderId, req.user);
    if (access.error) {
      return res.status(access.code).json({ success: false, message: access.error });
    }

    const messages = await ChatMessage.find({ order: req.params.orderId })
      .populate("sender", "name role")
      .sort({ createdAt: 1 });

    // Mark messages as read
    await ChatMessage.updateMany(
      {
        order: req.params.orderId,
        sender: { $ne: req.user._id },
        isRead: false,
      },
      { isRead: true, readAt: new Date() }
    );

    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/chat/:orderId — send a message ─────────────────────────────
router.post("/:orderId", protect, filterChatMessage, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: "Message cannot be empty." });
    }

    const access = await verifyOrderAccess(req.params.orderId, req.user);
    if (access.error) {
      return res.status(access.code).json({ success: false, message: access.error });
    }

    // If PII was detected by the filterChatMessage middleware, warn user
    // but still save the scrubbed version
    const piiWarning = req.piiDetected
      ? "⚠️ Contact information was detected and removed from your message."
      : null;

    const message = await ChatMessage.create({
      order: req.params.orderId,
      sender: req.user._id,
      senderRole: req.user.role,
      text: text.trim(),
      piiDetected: !!req.piiDetected,
    });

    const populated = await message.populate("sender", "name role");

    res.status(201).json({
      success: true,
      message: populated,
      warning: piiWarning,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/chat/:orderId/unread — unread count ─────────────────────────
router.get("/:orderId/unread", protect, async (req, res) => {
  try {
    const count = await ChatMessage.countDocuments({
      order: req.params.orderId,
      sender: { $ne: req.user._id },
      isRead: false,
    });
    res.json({ success: true, unreadCount: count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
