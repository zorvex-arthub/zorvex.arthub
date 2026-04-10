/**
 * routes/chat.js
 *
 * Order-scoped messaging between buyer and artist.
 * Admin can read any chat thread without restriction.
 *
 * Endpoints:
 *
 *   GET  /api/chat/:orderId          — Load all messages for an order
 *   POST /api/chat/:orderId          — Send a message (buyer or artist)
 *   GET  /api/chat/:orderId/unread   — Count unread messages for the calling user
 *   POST /api/chat/:orderId/read     — Mark all messages in an order as read
 *
 * Access rules:
 *   - Buyer: can read/write their own orders' chats
 *   - Artist: can read/write orders assigned to them
 *   - Admin: can read ANY order's chat (mandatory feature)
 *   - Admin cannot send messages as a participant (read-only oversight)
 *
 * PII detection (via Message model pre-save hook):
 *   Messages containing phone numbers, emails, or off-platform contact
 *   attempts are saved but flagged with piiDetected: true.
 *   The response includes a 'warning' field when PII is detected so the
 *   frontend can display the warning banner without blocking the message.
 */

'use strict';

const express  = require('express');
const mongoose = require('mongoose');
const Order    = require('../models/Order');
const Message  = require('../models/Message');
const { protect, requireRole } = require('../middleware/auth');

const router = express.Router();

// All chat routes require authentication
router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Verify the requesting user has access to this order's chat.
// Returns the order if access is granted, throws a typed error otherwise.
// Admin always has access.
// ─────────────────────────────────────────────────────────────────────────────
const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

const assertChatAccess = (order, user) => {
  if (user.role === 'admin') return; // admin reads all chats

  const buyerId  = order.buyer?._id?.toString()  || order.buyer?.toString();
  const artistId = order.artist?._id?.toString() || order.artist?.toString();
  const userId   = user._id.toString();

  if (userId !== buyerId && userId !== artistId) {
    const err = new Error('You do not have access to this order\'s chat.');
    err.status = 403;
    throw err;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Determine which statuses allow chat.
// Chat is available once an order is accepted — before that, there is no
// active commission to discuss.
// ─────────────────────────────────────────────────────────────────────────────
const CHAT_ALLOWED_STATUSES = new Set([
  'accepted',
  'advance_paid',
  'in_progress',
  'completed',
  'shipped',
  'delivered',
]);

const isChatOpen = (order) => CHAT_ALLOWED_STATUSES.has(order.status);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chat/:orderId
// Load all messages for an order, oldest → newest.
// Automatically marks all incoming messages as read for the calling user.
//
// Response:
//   {
//     messages: Message[],
//     order: { orderId, status, buyer, artist },
//     unreadCount: number  (always 0 after this call — all marked read)
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:orderId', async (req, res, next) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.orderId)
      .populate('buyer',  'name avatar')
      .populate('artist', 'name avatar')
      .select('orderId status buyer artist deliveryType')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    // Access check (admin bypasses)
    try {
      assertChatAccess(order, req.user);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ message: accessErr.message });
    }

    // For non-admin: chat is only available on orders in active statuses
    // Admin can always read, even on request_sent orders (oversight)
    if (req.user.role !== 'admin' && !isChatOpen(order)) {
      return res.status(400).json({
        message: 'Chat is not available until the artist accepts your commission.',
        chatStatus: 'locked',
      });
    }

    // Load messages and mark them as read in parallel
    const [messages] = await Promise.all([
      Message.forOrder(req.params.orderId),
      // Bulk-mark all messages in this order as read by the calling user
      Message.markAllReadByUser(req.params.orderId, req.user._id),
    ]);

    return res.json({
      messages,
      order: {
        _id:          order._id,
        orderId:      order.orderId,
        status:       order.status,
        deliveryType: order.deliveryType,
        buyer:        order.buyer,
        artist:       order.artist,
      },
      unreadCount: 0, // all marked read by this load
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat/:orderId
// Send a message in an order's chat thread.
// Admin cannot send messages (read-only oversight).
// Buyer and artist can only message each other on orders they are party to.
//
// Body:
//   text — the message content (required, 1–2000 characters)
//
// Response:
//   {
//     message: Message,       — the saved message document
//     warning?: string        — present if PII was detected
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId', async (req, res, next) => {
  try {
    // Admin cannot send messages — oversight only
    if (req.user.role === 'admin') {
      return res.status(403).json({
        message: 'Admins cannot send messages in order chats. Use the admin direct message system instead.',
      });
    }

    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const { text } = req.body;

    if (!text || !text.toString().trim()) {
      return res.status(400).json({ message: 'Message text is required.' });
    }

    const trimmedText = text.toString().trim();

    if (trimmedText.length > 2000) {
      return res.status(400).json({
        message: 'Message cannot exceed 2000 characters.',
      });
    }

    const order = await Order.findById(req.params.orderId)
      .select('status buyer artist orderId deliveryType')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    // Access check
    try {
      assertChatAccess(order, req.user);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ message: accessErr.message });
    }

    // Chat availability check
    if (!isChatOpen(order)) {
      return res.status(400).json({
        message: 'Chat is not available until the artist accepts the commission.',
        chatStatus: 'locked',
      });
    }

    // Create and save the message
    // PII detection runs automatically in the Message pre-save hook
    const savedMessage = await Message.create({
      order:      req.params.orderId,
      sender:     req.user._id,
      senderRole: req.user.role,
      text:       trimmedText,
      // The sender has obviously read their own message
      readBy:     [req.user._id],
    });

    // Populate sender for the response so the frontend can render immediately
    const populated = await Message.findById(savedMessage._id)
      .populate('sender', 'name avatar role')
      .lean();

    const response = { message: populated };

    // Include a warning if PII was detected — frontend displays a banner
    if (savedMessage.piiDetected) {
      response.warning =
        'Your message appears to contain personal contact information (phone number or email). ' +
        'Sharing contact details outside the platform violates our Terms of Service.';
    }

    return res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/chat/:orderId/unread
// Returns the count of unread messages for the calling user in a specific order.
// Used for the notification badge in the buyer/artist dashboards.
//
// Response:
//   { unreadCount: number, orderId: string }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:orderId/unread', async (req, res, next) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.orderId)
      .select('buyer artist status')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    try {
      assertChatAccess(order, req.user);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ message: accessErr.message });
    }

    const unreadCount = await Message.countUnread(
      req.params.orderId,
      req.user._id
    );

    return res.json({
      unreadCount,
      orderId: req.params.orderId,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat/:orderId/read
// Mark all messages in an order as read for the calling user.
// Called when a user opens the chat panel without necessarily calling
// the full GET /:orderId (e.g. clearing a notification badge).
//
// Response:
//   { message: string, markedCount: number }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:orderId/read', async (req, res, next) => {
  try {
    if (!isValidId(req.params.orderId)) {
      return res.status(400).json({ message: 'Invalid order ID.' });
    }

    const order = await Order.findById(req.params.orderId)
      .select('buyer artist status')
      .lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    try {
      assertChatAccess(order, req.user);
    } catch (accessErr) {
      return res.status(accessErr.status || 403).json({ message: accessErr.message });
    }

    const result = await Message.markAllReadByUser(
      req.params.orderId,
      req.user._id
    );

    return res.json({
      message:      'Messages marked as read.',
      markedCount:  result.modifiedCount || 0,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
