require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const connectDB = require("./config/db");

// ─── Connect MongoDB ───────────────────────────────────────────────────────
connectDB();

const app = express();

// ─── Security Headers ──────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: false,  // Adjust in production
    crossOriginEmbedderPolicy: false,
  })
);

// ─── CORS ──────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL || "http://localhost:3000",
      "http://localhost:5000",
      "http://127.0.0.1:5500",  // Live Server default
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ─── Body Parsers ──────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));       // 10mb for base64 images
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ─── Logger ────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
}

// ─── Global Rate Limiter ───────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 300,
  message: { success: false, message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", globalLimiter);

// ─── Auth Rate Limiter (stricter) ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, message: "Too many auth attempts. Please wait 15 minutes." },
});

// ─── Serve Static Frontend ─────────────────────────────────────────────────
// Place your HTML files in the /public folder
app.use(express.static(path.join(__dirname, "public")));

// ─── API Routes ────────────────────────────────────────────────────────────
app.use("/api/auth",    authLimiter, require("./routes/auth"));
app.use("/api/artists", require("./routes/artists"));
app.use("/api/orders",  require("./routes/orders"));
app.use("/api/chat",    require("./routes/chat"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/admin",   require("./routes/admin"));

// ─── Health Check ─────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ZorvEx API is running",
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

// ─── Catch-all: serve frontend for SPA ────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Global Error Handler ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);

  if (err.name === "CastError") {
    return res.status(400).json({ success: false, message: "Invalid ID format." });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(409).json({
      success: false,
      message: `This ${field} is already in use.`,
      field,
    });
  }
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ success: false, message: messages[0] });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error.",
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`\n🚀 ZorvEx API running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Health: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
