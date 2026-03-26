// ============================================================
//  middleware/authMiddleware.js  —  ZorvEx JWT Auth Guard
// ============================================================
//
//  Usage in routes:
//
//    // Default import (the core guard):
//    const authMiddleware = require("./middleware/authMiddleware");
//
//    // Named imports used by orders.js / artists.js:
//    const { protect, restrictTo, authorize } = require("./middleware/authMiddleware");
//
//    // Protect a whole router:
//    app.use("/api/users", protect, require("./routes/user"));
//
//    // Role-specific protection:
//    router.post("/order",  protect, restrictTo("buyer"),  createOrder);
//    router.put("/profile", protect, authorize("artist"),  updateProfile);
//    router.get("/stats",   protect, restrictTo("admin"),  getStats);
//
// ============================================================

const jwt  = require("jsonwebtoken");
const User = require("../models/User");

// ─────────────────────────────────────────────────────────────
//  Core middleware — verifies JWT from Authorization header
//  or cookie, attaches decoded user to req.user
// ─────────────────────────────────────────────────────────────
const authMiddleware = async (req, res, next) => {
  try {
    let token;

    // 1. Check "Authorization: Bearer <token>" header (preferred)
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    // 2. Fallback: check cookie (set by login endpoint)
    if (!token && req.cookies && req.cookies.zx_token) {
      token = req.cookies.zx_token;
    }

    // ── No token found ──────────────────────────────────────
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No authentication token provided.",
        hint:    "Add 'Authorization: Bearer <your_token>' to your request headers.",
      });
    }

    // ── Verify token signature and expiry ───────────────────
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      if (jwtErr.name === "TokenExpiredError") {
        return res.status(401).json({
          success: false,
          message: "Session expired. Please sign in again.",
          expired: true,
        });
      }
      return res.status(401).json({
        success: false,
        message: "Invalid token. Authentication failed.",
      });
    }

    // ── Fetch the real user from DB ─────────────────────────
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "The account associated with this token no longer exists.",
      });
    }

    // ── Account suspension check ────────────────────────────
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Your account has been suspended. Contact support at zorvexinfo@gmail.com",
      });
    }

    // ── Attach user to request object ───────────────────────
    req.user = user;
    next();

  } catch (err) {
    console.error("[authMiddleware] Unexpected error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Authentication service error. Please try again.",
    });
  }
};

// ─────────────────────────────────────────────────────────────
//  protect — alias for the core middleware.
//  Used by routes that do: const { protect } = require(...)
// ─────────────────────────────────────────────────────────────
const protect = authMiddleware;

// ─────────────────────────────────────────────────────────────
//  restrictTo(...roles) — factory that returns a middleware.
//  Used by orders.js:  restrictTo("buyer") / restrictTo("admin")
//
//  Example:
//    router.post("/", protect, restrictTo("buyer"), handler);
// ─────────────────────────────────────────────────────────────
const restrictTo = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Forbidden — Requires one of: ${allowedRoles.join(", ")}.`,
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────
//  authorize(...roles) — alias for restrictTo.
//  Used by artists.js: authorize("artist")
// ─────────────────────────────────────────────────────────────
const authorize = restrictTo;

// ─────────────────────────────────────────────────────────────
//  Role guard helpers attached directly to authMiddleware
//  so you can also do: authMiddleware.adminOnly
// ─────────────────────────────────────────────────────────────

/** Allow only admins */
authMiddleware.adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Forbidden — Admin access required.",
    });
  }
  next();
};

/** Allow only artists */
authMiddleware.artistOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "artist") {
    return res.status(403).json({
      success: false,
      message: "Forbidden — Artist access required.",
    });
  }
  next();
};

/** Allow only buyers */
authMiddleware.buyerOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "buyer") {
    return res.status(403).json({
      success: false,
      message: "Forbidden — Buyer access required.",
    });
  }
  next();
};

/**
 * Allow multiple roles.
 * Usage:  authMiddleware.roles("admin", "artist")
 */
authMiddleware.roles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: `Forbidden — Requires one of: ${allowedRoles.join(", ")}.`,
    });
  }
  next();
};

// ─────────────────────────────────────────────────────────────
//  Utility: generate a signed JWT token
//  Usage in login route:
//    const { generateToken } = require("../middleware/authMiddleware");
//    const token = generateToken(user._id);
// ─────────────────────────────────────────────────────────────
const generateToken = (userId) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not set in environment variables.");
  }
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
};

// Also attach to authMiddleware for backward compat
authMiddleware.generateToken = generateToken;

// ─────────────────────────────────────────────────────────────
//  Exports
//
//  Default export  → the core middleware function (+ helpers as properties)
//  Named exports   → protect, restrictTo, authorize, generateToken
//                    (what orders.js / artists.js / auth.js destructure)
// ─────────────────────────────────────────────────────────────
module.exports = authMiddleware;

// Named exports — these make destructuring work:
//   const { protect, restrictTo, authorize } = require("../middleware/authMiddleware");
module.exports.protect       = protect;
module.exports.restrictTo    = restrictTo;
module.exports.authorize     = authorize;
module.exports.generateToken = generateToken;
