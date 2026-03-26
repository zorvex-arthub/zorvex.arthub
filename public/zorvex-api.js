/**
 * ZorvEx API Client — replaces zorvex-shared.js localStorage approach
 * Include this on every page: <script src="/zorvex-api.js"></script>
 */

const ZX = (() => {
  const API = "/api";

  // ─── Token management ──────────────────────────────────────────────────
  const getToken = () => localStorage.getItem("zx_jwt");
  const setToken = (t) => localStorage.setItem("zx_jwt", t);
  const clearToken = () => localStorage.removeItem("zx_jwt");

  // ─── Current user (cached) ─────────────────────────────────────────────
  let _currentUser = null;
  try {
    _currentUser = JSON.parse(localStorage.getItem("zx_user") || "null");
  } catch {}

  const setUser = (u) => {
    _currentUser = u;
    localStorage.setItem("zx_user", JSON.stringify(u));
  };
  const getUser = () => _currentUser;
  const clearUser = () => {
    _currentUser = null;
    localStorage.removeItem("zx_user");
  };

  // ─── Core fetch wrapper ────────────────────────────────────────────────
  const req = async (method, path, body = null, isFormData = false) => {
    const headers = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (!isFormData) headers["Content-Type"] = "application/json";

    const opts = { method, headers, credentials: "include" };
    if (body && method !== "GET") {
      opts.body = isFormData ? body : JSON.stringify(body);
    }

    const res = await fetch(API + path, opts);
    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data.message || "Request failed");
      err.field = data.field;
      err.status = res.status;
      throw err;
    }
    return data;
  };

  // ─── AUTH ──────────────────────────────────────────────────────────────
  const auth = {
    async register(name, email, phone, password, role = "buyer") {
      const data = await req("POST", "/auth/register", { name, email, phone, password, role });
      setToken(data.token);
      setUser(data.user);
      return data;
    },

    async login(email, password) {
      const data = await req("POST", "/auth/login", { email, password });
      setToken(data.token);
      setUser(data.user);
      return data;
    },

    async logout() {
      try { await req("POST", "/auth/logout"); } catch {}
      clearToken();
      clearUser();
      window.location.href = "/index.html";
    },

    async me() {
      const data = await req("GET", "/auth/me");
      setUser(data.user);
      return data;
    },

    isLoggedIn: () => !!getToken() && !!getUser(),
    isBuyer:    () => getUser()?.role === "buyer",
    isArtist:   () => getUser()?.role === "artist",
    isAdmin:    () => getUser()?.role === "admin",
    getUser,
  };

  // ─── ARTISTS ───────────────────────────────────────────────────────────
  const artists = {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return req("GET", `/artists${qs ? "?" + qs : ""}`);
    },
    get: (id) => req("GET", `/artists/${id}`),
    getPricing: (id) => req("GET", `/artists/${id}/pricing`),
    myProfile: () => req("GET", "/artists/me/profile"),
    updateProfile: (data) => req("PUT", "/artists/profile", data),
  };

  // ─── ORDERS ────────────────────────────────────────────────────────────
  const orders = {
    create: (data) => req("POST", "/orders", data),
    myOrders: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return req("GET", `/orders/my${qs ? "?" + qs : ""}`);
    },
    artistOrders: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return req("GET", `/orders/artist/mine${qs ? "?" + qs : ""}`);
    },
    adminAll: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return req("GET", `/orders/admin/all${qs ? "?" + qs : ""}`);
    },
    adminStats: () => req("GET", "/orders/admin/stats"),
    get: (id) => req("GET", `/orders/${id}`),
    payAdvance: (id, paymentId) => req("PATCH", `/orders/${id}/pay-advance`, { paymentId }),
    artistAction: (id, action, reason) =>
      req("PATCH", `/orders/${id}/artist-action`, { action, reason }),
    startWork: (id) => req("PATCH", `/orders/${id}/start`),
    complete: (id, artworkFileUrl) =>
      req("PATCH", `/orders/${id}/complete`, { artworkFileUrl }),
    adminForward: (id, notes) =>
      req("PATCH", `/orders/${id}/admin-forward`, { adminNotes: notes }),
    adminShip: (id, trackingId) =>
      req("PATCH", `/orders/${id}/admin-ship`, { trackingId }),
    adminDeliver: (id) => req("PATCH", `/orders/${id}/admin-deliver`),
    getDeliveryFee: (buyerPincode, artistId) =>
      req("GET", `/orders/delivery-fee?buyerPincode=${buyerPincode}&artistId=${artistId}`),
  };

  // ─── CHAT ──────────────────────────────────────────────────────────────
  const chat = {
    load: (orderId) => req("GET", `/chat/${orderId}`),
    send: (orderId, text) => req("POST", `/chat/${orderId}`, { text }),
    unread: (orderId) => req("GET", `/chat/${orderId}/unread`),
  };

  // ─── REVIEWS ───────────────────────────────────────────────────────────
  const reviews = {
    forArtist: (profileId) => req("GET", `/reviews/artist/${profileId}`),
    submit: (orderId, rating, text, tag) =>
      req("POST", "/reviews", { orderId, rating, text, tag }),
    eligible: () => req("GET", "/reviews/eligible"),
  };

  // ─── ADMIN ─────────────────────────────────────────────────────────────
  const admin = {
    dashboard: () => req("GET", "/admin/dashboard"),
    users: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return req("GET", `/admin/users${qs ? "?" + qs : ""}`);
    },
    toggleUser: (id) => req("PATCH", `/admin/users/${id}/deactivate`),
    verifyArtist: (profileId, feature) =>
      req("PATCH", `/admin/artists/${profileId}/verify`, { feature }),
    unverifiedArtists: () => req("GET", "/admin/artists/unverified"),
    seedAdmin: () => req("POST", "/admin/seed-admin"),
  };

  // ─── UI Helpers ────────────────────────────────────────────────────────
  const STATUS_LABEL = {
    request_sent: "Request Sent",
    waiting:      "Waiting for Artist",
    accepted:     "Accepted",
    advance_paid: "Advance Paid",
    in_progress:  "In Progress",
    completed:    "Completed",
    shipped:      "Shipped",
    delivered:    "Delivered",
    rejected:     "Declined",
  };

  const STATUS_COLOR = {
    request_sent: "#c9a84c",
    waiting:      "#a07c2a",
    accepted:     "#22c55e",
    advance_paid: "#22c55e",
    in_progress:  "#3b82f6",
    completed:    "#8b5cf6",
    shipped:      "#f59e0b",
    delivered:    "#22c55e",
    rejected:     "#e05c5c",
  };

  // Auth-guard: redirects if not logged in or wrong role
  const guardRoute = (requiredRole) => {
    const user = getUser();
    if (!user || !getToken()) {
      window.location.href = "/login.html?redirect=" + encodeURIComponent(window.location.pathname);
      return false;
    }
    if (requiredRole && user.role !== requiredRole) {
      const dashMap = {
        buyer: "/dashboard-buyer.html",
        artist: "/dashboard-artist.html",
        admin: "/dashboard-admin.html",
      };
      window.location.href = dashMap[user.role] || "/index.html";
      return false;
    }
    return true;
  };

  // Build standard nav auth buttons
  const buildNavAuth = (containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const user = getUser();
    if (user) {
      const dash = user.role === "artist"
        ? "/dashboard-artist.html"
        : user.role === "admin"
        ? "/dashboard-admin.html"
        : "/dashboard-buyer.html";
      el.innerHTML = `
        <a href="${dash}" class="nav-btn">Dashboard</a>
        <button class="nav-btn fill" onclick="ZX.auth.logout()">Sign Out</button>`;
    } else {
      el.innerHTML = `
        <a href="/login.html" class="nav-btn">Sign In</a>
        <a href="/login.html?mode=register" class="nav-btn fill">Join Free</a>`;
    }
  };

  return {
    auth, artists, orders, chat, reviews, admin,
    STATUS_LABEL, STATUS_COLOR,
    guardRoute, buildNavAuth,
    getToken, getUser,
  };
})();
