// ============================================================
//  middleware/authMiddleware.js  —  ZorvEx JWT Auth Guard
// ============================================================
//
//  Usage in server.js / routes:
//
//    const authMiddleware = require("./middleware/authMiddleware");
//
//    // Protect a whole router:
//    app.use("/api/users", authMiddleware, require("./routes/user"));
//
//    // Protect a single route:
//    router.get("/profile", authMiddleware, getProfile);
//
//    // Role-specific protection (compose with authMiddleware):
//    router.delete("/user/:id", authMiddleware, authMiddleware.adminOnly, deleteUser);
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
      token = authHeader.split(" ")[1];         // Extract token after "Bearer "
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
      // Distinguish between expired and truly invalid
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
    //   (confirms user still exists and wasn't deleted)
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
    req.user = user;   // Available as req.user in all subsequent handlers

    next();            // Pass control to the next middleware / route handler

  } catch (err) {
    // Unexpected server error (e.g. DB down during User.findById)
    console.error("[authMiddleware] Unexpected error:", err.message);
    return res.status(500).json({
      success: false,
      message: "Authentication service error. Please try again.",
    });
  }
};

// ─────────────────────────────────────────────────────────────
//  Role guard helpers — attach to authMiddleware for convenience
//  so you can do: authMiddleware.adminOnly
//
//  Example:
//    router.get("/stats", authMiddleware, authMiddleware.adminOnly, getStats);
//    router.post("/order", authMiddleware, authMiddleware.buyerOnly, createOrder);
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
 * Returns a middleware function.
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
//    const token = authMiddleware.generateToken(user._id);
// ─────────────────────────────────────────────────────────────
authMiddleware.generateToken = (userId) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not set in environment variables.");
  }
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
};

// ─────────────────────────────────────────────────────────────
//  Default export — the core middleware function
//  Named role guards are attached as properties above
// ─────────────────────────────────────────────────────────────
module.exports = authMiddleware;
