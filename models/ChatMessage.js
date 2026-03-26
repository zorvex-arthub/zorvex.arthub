const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderRole: {
      type: String,
      enum: ["buyer", "artist", "admin"],
      required: true,
    },
    // Raw message text — stored AFTER PII scrubbing
    text: {
      type: String,
      required: [true, "Message text is required"],
      trim: true,
      maxlength: [1000, "Message too long"],
    },
    // Was PII detected and replaced?
    piiDetected: { type: Boolean, default: false },
    // Warning count — if sender repeats 3x, flag for admin
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
  },
  { timestamps: true }
);

// Index for fetching chat by order efficiently
chatMessageSchema.index({ order: 1, createdAt: 1 });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
