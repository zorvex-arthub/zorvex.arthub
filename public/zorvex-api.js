/**
 * ZorvEx API Client — v3
 *
 * Phase 7 integration — all field name fixes applied:
 *   - guardRoute: phoneVerified gate added
 *   - auth.sendOtp / auth.verifyOtp added (Phase 6)
 *   - artists.myProfile: path corrected /artists/me/profile
 *   - artists.setAvailability: PATCH (was incorrectly PATCH but path was /me/profile — now correct)
 *   - orders.artistOrders: path corrected /orders/artist (was /orders/artist/mine)
 *   - orders.adminAll / adminStats: now point to /orders/admin/all and /orders/admin/stats
 *   - orders.adminForward / adminShip / adminDeliver: correct PATCH paths
 *   - admin.dashboard: points to /admin/dashboard
 *   - admin.orders: points to /admin/orders
 *   - admin.orderStats: points to /admin/orders/stats
 *   - admin.reportSubmit: POST /admin/reports (for buyers/artists)
 *
 * Status field canonical names (used by all dashboards):
 *   pricing.totalAmount     (not .total)
 *   pricing.advanceAmount   (not .advance)
 *   pricing.remainingAmount
 *   pricing.platformFee     (not .platformCommission)
 *   pricing.deliveryFee
 *   selectedTier.name       (not .pricingTierName)
 *   shipping.trackingId     (not .trackingId at root)
 *   statusHistory           (not .history)
 *   orderId                 (now a real field from Phase 2 Order.js)
 *
 * Include on every page: <script src="/zorvex-api.js"></script>
 */

const ZX = (() => {
  'use strict';

  const API = '/api';

  // ─────────────────────────────────────────────────────────────────────────
  // TOKEN MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────
  const getToken   = () => localStorage.getItem('zx_jwt');
  const setToken   = (t) => localStorage.setItem('zx_jwt', t);
  const clearToken = () => localStorage.removeItem('zx_jwt');

  // ─────────────────────────────────────────────────────────────────────────
  // CURRENT USER (in-memory + localStorage cache)
  // ─────────────────────────────────────────────────────────────────────────
  let _currentUser = null;
  try {
    _currentUser = JSON.parse(localStorage.getItem('zx_user') || 'null');
  } catch { _currentUser = null; }

  const setUser   = (u) => { _currentUser = u; localStorage.setItem('zx_user', JSON.stringify(u)); };
  const getUser   = () => _currentUser;
  const clearUser = () => { _currentUser = null; localStorage.removeItem('zx_user'); };

  // ─────────────────────────────────────────────────────────────────────────
  // STRUCTURED ERROR CLASS
  // ─────────────────────────────────────────────────────────────────────────
  class ZXError extends Error {
    constructor(message, status, field = null, errors = []) {
      super(message);
      this.name   = 'ZXError';
      this.status = status;
      this.field  = field;
      this.errors = errors;
    }
    get isClientError()  { return this.status >= 400 && this.status < 500; }
    get isFieldError()   { return !!this.field; }
    get isNetworkError() { return !this.status; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CORE FETCH WRAPPER
  // ─────────────────────────────────────────────────────────────────────────
  const req = async (method, path, body = null, isFormData = false) => {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (!isFormData) headers['Content-Type'] = 'application/json';

    const opts = { method, headers, credentials: 'include' };
    if (body && method !== 'GET') {
      opts.body = isFormData ? body : JSON.stringify(body);
    }

    let res, data;
    try {
      res  = await fetch(API + path, opts);
      data = await res.json();
    } catch (networkErr) {
      throw new ZXError('Network error. Please check your connection.', 0);
    }

    if (!res.ok) {
      // 401 — clear stale session so guards redirect cleanly
      if (res.status === 401) {
        clearToken();
        clearUser();
      }

      // 403 with needsPhoneVerification — redirect to verification page
      if (res.status === 403 && data.needsPhoneVerification) {
        window.location.href = '/phone-verify.html';
        // Return a never-resolving promise so callers don't see an error flash
        return new Promise(() => {});
      }

      throw new ZXError(
        data.message || 'Something went wrong.',
        res.status,
        data.field   || null,
        data.errors  || []
      );
    }

    return data;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────────────────────────────────
  const auth = {
    /**
     * Email + password registration.
     * @param {string} name
     * @param {string} email
     * @param {string} phone     10-digit Indian number
     * @param {string} password  Must start capital + contain digit
     * @param {"buyer"|"artist"} [role="buyer"]
     */
    async register(name, email, phone, password, role = 'buyer') {
      const data = await req('POST', '/auth/register', { name, email, phone, password, role });
      setToken(data.token);
      setUser(data.user);
      return data;
    },

    /** Email + password login. */
    async login(email, password) {
      const data = await req('POST', '/auth/login', { email, password });
      setToken(data.token);
      setUser(data.user);
      return data;
    },

    /**
     * Google Sign-In via Firebase.
     * Call after firebase.auth().signInWithPopup() to exchange Firebase
     * ID token for a ZorvEx JWT.
     *
     * @param {string}           idToken      — Firebase ID token
     * @param {"buyer"|"artist"} [role]       — Only used on first sign-up
     * @param {boolean}          [acceptTerms=false]
     */
    async googleSignIn(idToken, role = 'buyer', acceptTerms = false) {
      if (!idToken) throw new ZXError('Firebase ID token is required.', 400);
      if (!acceptTerms) {
        throw new ZXError(
          'You must accept the Terms & Conditions to continue.',
          400,
          'acceptTerms'
        );
      }
      const data = await req('POST', '/auth/google', { idToken, role });
      setToken(data.token);
      setUser(data.user);
      return data;
    },

    /**
     * Send OTP to a phone number (Phase 6 — Identity Lock).
     * @param {string} phone — 10-digit Indian number
     */
    async sendOtp(phone) {
      return req('POST', '/users/phone/send-otp', { phone });
    },

    /**
     * Verify OTP and unlock platform access (Phase 6 — Identity Lock).
     * On success, refreshes the local user cache so phoneVerified = true.
     * @param {string} phone — 10-digit Indian number
     * @param {string} otp   — 6-digit OTP
     */
    async verifyOtp(phone, otp) {
      const data = await req('POST', '/users/phone/verify-otp', { phone, otp });
      if (data.user) setUser(data.user);
      return data;
    },

    /** Clear local session and redirect to index. */
    async logout() {
      try { await req('POST', '/auth/logout'); } catch { /* stateless */ }
      clearToken();
      clearUser();
      window.location.href = '/index.html';
    },

    /**
     * Fetch fresh user data from the server and refresh local cache.
     * Call on dashboard load to pick up role/profile/phoneVerified changes.
     */
    async me() {
      const data = await req('GET', '/auth/me');
      setUser(data.user);
      return data;
    },

    isLoggedIn: () => !!getToken() && !!getUser(),
    isBuyer:    () => getUser()?.role === 'buyer',
    isArtist:   () => getUser()?.role === 'artist',
    isAdmin:    () => getUser()?.role === 'admin',
    getUser,
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ARTISTS
  // ─────────────────────────────────────────────────────────────────────────
  const artists = {
    /**
     * List artists with optional filters.
     * @param {{ category?, tag?, availability?, sort?, page?, limit?, search? }} [params]
     */
    list:  (params = {}) => req('GET', `/artists?${new URLSearchParams(params)}`),
    get:   (id)          => req('GET', `/artists/${id}`),

    /** Phase 5 fix: was /artists/me/profile (correct path) */
    myProfile: () => req('GET', '/artists/me/profile'),

    /** Update artist profile fields (not pricingTiers — use addPricingTier). */
    updateProfile: (data) => req('PUT', '/artists/profile', data),

    /**
     * Add a portfolio image.
     * @param {{ title, category?, imageUrl }} item
     */
    addPortfolio: (item) => req('POST', '/artists/portfolio', item),

    /**
     * Remove a portfolio image by its _id.
     * @param {string} itemId
     */
    removePortfolio: (itemId) => req('DELETE', `/artists/portfolio/${itemId}`),

    /**
     * Add a pricing tier.
     * @param {{ name, format?, price, delivery?, featured? }} tier
     */
    addPricingTier: (tier) => req('POST', '/artists/pricing', tier),

    /**
     * Update a pricing tier.
     * @param {string} tierId
     * @param {{ name?, format?, price?, delivery?, featured? }} updates
     */
    updatePricingTier: (tierId, updates) => req('PUT', `/artists/pricing/${tierId}`, updates),

    /**
     * Remove a pricing tier.
     * @param {string} tierId
     */
    removePricingTier: (tierId) => req('DELETE', `/artists/pricing/${tierId}`),

    /**
     * Update artist availability.
     * Phase 5 fix: uses PATCH (was PUT — backend now requires PATCH).
     * @param {"open"|"busy"|"closed"} status
     */
    setAvailability: (status) => req('PATCH', '/artists/availability', { availability: status }),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ORDERS
  // ─────────────────────────────────────────────────────────────────────────
  const orders = {
    /**
     * Place a new commission order.
     * @param {{
     *   artistId, artistProfileId?, category, subCategory?,
     *   description, deadline, deliveryType,
     *   selectedTier: { name, format?, basePrice },
     *   deliveryAddress?: { name, phone, address, city, state, pincode },
     *   referenceImage?, buyerPhone?
     * }} data
     */
    create: (data) => req('POST', '/orders', data),

    /** Buyer: list own orders. */
    myOrders: (params = {}) => req('GET', `/orders/my?${new URLSearchParams(params)}`),

    /**
     * Artist: list incoming orders.
     * Phase 5 fix: was /orders/artist/mine — corrected to /orders/artist
     */
    artistOrders: (params = {}) => req('GET', `/orders/artist?${new URLSearchParams(params)}`),

    /**
     * Admin: all orders with filters.
     * Phase 5 fix: was missing — now points to /orders/admin/all
     */
    adminAll: (params = {}) => req('GET', `/orders/admin/all?${new URLSearchParams(params)}`),

    /**
     * Admin: order KPI stats.
     * Phase 5 fix: was missing — now points to /orders/admin/stats
     */
    adminStats: () => req('GET', '/orders/admin/stats'),

    /** Get a single order by ID. */
    get: (id) => req('GET', `/orders/${id}`),

    // ── Payment ──

    /** Buyer: create Razorpay order for 50% advance. Returns { razorpayOrderId, amount, key }. */
    createAdvancePayment: (id) => req('POST', `/orders/${id}/pay/advance`),

    /** Buyer: verify advance payment signature. */
    payAdvance: (id, paymentData) => req('POST', `/orders/${id}/pay/advance/verify`, paymentData),

    /** Buyer: create Razorpay order for 50% final payment. */
    createFinalPayment: (id) => req('POST', `/orders/${id}/pay/final`),

    /** Buyer: verify final payment signature. */
    payFinal: (id, paymentData) => req('POST', `/orders/${id}/pay/final/verify`, paymentData),

    // ── Artist actions ──

    /**
     * Artist: accept or reject an order.
     * Phase 5 fix: replaced non-existent PUT /accept and PUT /reject.
     * Now uses PATCH /:id/artist-action.
     * @param {string} id
     * @param {"accepted"|"rejected"} action
     * @param {string} [reason] — required when action is "rejected"
     */
    artistAction: (id, action, reason) =>
      req('PATCH', `/orders/${id}/artist-action`, { action, reason }),

    /** Artist: mark work as started. Status: advance_paid → in_progress. */
    startWork: (id) => req('PATCH', `/orders/${id}/start`),

    /**
     * Artist: submit completed artwork.
     * @param {string} id
     * @param {string} [artworkFileUrl] — required for digital orders
     */
    complete: (id, artworkFileUrl) =>
      req('PATCH', `/orders/${id}/complete`, { artworkUrl: artworkFileUrl }),

    // ── Admin actions ──

    /**
     * Admin: forward request_sent order to artist.
     * Phase 5 fix: was missing.
     * @param {string} id
     * @param {string} [notes]
     */
    adminForward: (id, notes) =>
      req('PATCH', `/orders/${id}/admin-forward`, { adminNotes: notes }),

    /**
     * Admin: add tracking ID and mark as shipped.
     * Phase 5 fix: was missing.
     * @param {string} id
     * @param {string} trackingId
     * @param {string} [carrier]
     */
    adminShip: (id, trackingId, carrier) =>
      req('PATCH', `/orders/${id}/admin-ship`, { trackingId, carrier }),

    /**
     * Admin: mark order as delivered.
     * Phase 5 fix: was missing.
     */
    adminDeliver: (id) => req('PATCH', `/orders/${id}/admin-deliver`),

    /** Cancel order (buyer, before advance paid). */
    cancel: (id, reason) => req('POST', `/orders/${id}/cancel`, { reason }),

    /** Get live Shiprocket tracking for a physical order. */
    tracking: (id) => req('GET', `/orders/${id}/tracking`),

    /**
     * Get estimated delivery fee for the order form.
     * @param {string} buyerPincode
     * @param {string} artistId  — User ID of the artist
     */
    getDeliveryFee: (buyerPincode, artistId) =>
      req('GET', `/orders/delivery-fee?buyerPincode=${buyerPincode}&artistId=${artistId}`),

    /**
     * Get shipping estimate (public, no auth).
     * @param {string} pickupPincode
     * @param {string} deliveryPincode
     * @param {number} [weight=0.5]
     */
    shippingEstimate: (pickupPincode, deliveryPincode, weight = 0.5) =>
      req('GET', `/orders/shipping/estimate?pickupPincode=${pickupPincode}&deliveryPincode=${deliveryPincode}&weight=${weight}`),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // CHAT
  // ─────────────────────────────────────────────────────────────────────────
  const chat = {
    /** Load all messages for an order (also marks them as read). */
    load:   (orderId)       => req('GET',  `/chat/${orderId}`),
    /** Send a message. */
    send:   (orderId, text) => req('POST', `/chat/${orderId}`, { text }),
    /** Get unread message count for this user in an order. */
    unread: (orderId)       => req('GET',  `/chat/${orderId}/unread`),
    /** Mark all messages in an order as read for the calling user. */
    markRead: (orderId)     => req('POST', `/chat/${orderId}/read`),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // REVIEWS
  // ─────────────────────────────────────────────────────────────────────────
  const reviews = {
    /** Public: get paginated reviews for an artist profile. */
    forArtist: (profileId, params = {}) =>
      req('GET', `/reviews/artist/${profileId}?${new URLSearchParams(params)}`),

    /**
     * Buyer: submit a review for a delivered order.
     * @param {string} orderId
     * @param {number} rating  — integer 1–5
     * @param {string} text    — min 10 chars
     * @param {string} [tag]   — optional category tag
     */
    submit: (orderId, rating, text, tag) =>
      req('POST', '/reviews', { orderId, rating, text, tag }),

    /** Buyer: list delivered orders eligible for review. */
    eligible: () => req('GET', '/reviews/eligible'),

    /** Get the review for a specific order (buyer/artist/admin). */
    forOrder: (orderId) => req('GET', `/reviews/order/${orderId}`),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ADMIN
  // ─────────────────────────────────────────────────────────────────────────
  const admin = {
    /** Dashboard KPI stats + recent orders. */
    dashboard: () => req('GET', '/admin/dashboard'),

    /** List all users with optional role/search filters. */
    users: (params = {}) => req('GET', `/admin/users?${new URLSearchParams(params)}`),

    /** Get a single user's full admin profile. */
    getUser: (id) => req('GET', `/admin/users/${id}`),

    /** Toggle a user's isActive status. */
    toggleUser: (id) => req('PATCH', `/admin/users/${id}/deactivate`),

    /** List unverified artist profiles. */
    unverifiedArtists: () => req('GET', '/admin/artists/unverified'),

    /**
     * Verify (and optionally feature) an artist.
     * @param {string}  profileId
     * @param {boolean} [feature=false]
     */
    verifyArtist: (profileId, feature) =>
      req('PATCH', `/admin/artists/${profileId}/verify`, { feature }),

    /**
     * Add to blacklist.
     * @param {"user"|"email"|"phone"|"ip"} type
     * @param {string} value
     * @param {string} reason
     * @param {string} [userId]
     * @param {string} [expiresAt]  — ISO date string for temporary ban
     */
    blacklistUser: (type, value, reason, userId = null, expiresAt = null) =>
      req('POST', '/admin/blacklist', { type, value, reason, userId, expiresAt }),

    /**
     * Lift a blacklist entry.
     * @param {string} blacklistId — _id of the Blacklist document
     */
    removeBlacklist: (blacklistId) =>
      req('DELETE', `/admin/blacklist/${blacklistId}`),

    /**
     * List active blacklist entries.
     * @param {{ type?, page?, limit? }} [params]
     */
    listBlacklist: (params = {}) =>
      req('GET', `/admin/blacklist?${new URLSearchParams(params)}`),

    /** Admin chat oversight: list all order chat threads. */
    chats: (params = {}) => req('GET', `/admin/chats?${new URLSearchParams(params)}`),

    /** Admin chat oversight: read a specific order's full chat. */
    readChat: (orderId) => req('GET', `/admin/chats/${orderId}`),

    /**
     * Submit a report (accessible to all authenticated users, not just admin).
     * @param {{ reason, category?, reportedUserId?, reportedOrderId? }} data
     */
    reportSubmit: (data) => req('POST', '/admin/reports', data),

    /** Admin: list all reports. */
    reports: (params = {}) => req('GET', `/admin/reports?${new URLSearchParams(params)}`),

    /**
     * Admin: resolve or dismiss a report.
     * @param {string} id
     * @param {"resolved"|"dismissed"|"under_review"} status
     * @param {string} [adminNotes]
     */
    resolveReport: (id, status, adminNotes) =>
      req('PATCH', `/admin/reports/${id}/resolve`, { status, adminNotes }),

    /**
     * Admin: all orders (same data as orders.adminAll but via admin router).
     * Phase 5 fix: added.
     */
    orders: (params = {}) => req('GET', `/admin/orders?${new URLSearchParams(params)}`),

    /** Admin: order stats (same as orders.adminStats but via admin router). */
    orderStats: () => req('GET', '/admin/orders/stats'),

    /** Seed admin user (dev only). */
    seedAdmin: () => req('POST', '/admin/seed-admin'),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // TERMS
  // ─────────────────────────────────────────────────────────────────────────
  const _termsCache = {};

  const terms = {
    /** Full Terms & Conditions. */
    get: async () => {
      if (_termsCache.terms) return _termsCache.terms;
      const data = await req('GET', '/terms');
      _termsCache.terms = data;
      return data;
    },
    /** Privacy Policy. */
    privacy: async () => {
      if (_termsCache.privacy) return _termsCache.privacy;
      const data = await req('GET', '/terms/privacy');
      _termsCache.privacy = data;
      return data;
    },
    /** Refund Policy. */
    refund: async () => {
      if (_termsCache.refund) return _termsCache.refund;
      const data = await req('GET', '/terms/refund');
      _termsCache.refund = data;
      return data;
    },

    /**
     * Render a terms document into a container element.
     * @param {string} containerId
     * @param {"terms"|"privacy"|"refund"} [type="terms"]
     */
    render: async (containerId, type = 'terms') => {
      const el = document.getElementById(containerId);
      if (!el) return;
      el.innerHTML = `<p style="color:var(--text-dim)">Loading…</p>`;
      try {
        const fetchFn = { terms: terms.get, privacy: terms.privacy, refund: terms.refund };
        const doc = await (fetchFn[type] || terms.get)();
        const sections = doc.sections.map(s => `
          <details class="zx-terms-section" open>
            <summary class="zx-terms-heading">${s.heading}</summary>
            <p class="zx-terms-body">${s.body}</p>
          </details>`).join('');
        el.innerHTML = `
          <div class="zx-terms-doc">
            <h2 class="zx-terms-title">${doc.title}</h2>
            <p class="zx-terms-meta">Last updated: ${doc.lastUpdated} ·
               Questions? <a href="mailto:${doc.contact}">${doc.contact}</a></p>
            ${sections}
          </div>`;
      } catch {
        el.innerHTML = `<p style="color:#e05c5c">Failed to load. Please refresh.</p>`;
      }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ADDRESSES — helpers for savedAddresses (max 2) on the User profile
  // ─────────────────────────────────────────────────────────────────────────
  const addresses = {
    /** Returns saved addresses from local cache. */
    getSaved: () => getUser()?.savedAddresses || [],

    /** True if the user has at least one saved address. */
    hasSaved: () => (getUser()?.savedAddresses?.length || 0) > 0,

    /**
     * Populates a delivery address form with a saved address.
     * Expects field IDs: addr-name, addr-phone, addr-address,
     *                    addr-city, addr-state, addr-pincode
     * @param {number} [index=0]
     */
    fillForm: (index = 0) => {
      const saved = addresses.getSaved();
      if (!saved[index]) return;
      const a = saved[index];
      const fill = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
      };
      fill('addr-name',    a.name);
      fill('addr-phone',   a.phone);
      fill('addr-address', a.address);
      fill('addr-city',    a.city);
      fill('addr-state',   a.state);
      fill('addr-pincode', a.pincode);
    },

    /**
     * Renders "Use saved address" buttons into a container.
     * @param {string}    containerId
     * @param {Function}  [onSelect]  — callback(addressObject) after fill
     */
    renderSavedPicker: (containerId, onSelect) => {
      const el = document.getElementById(containerId);
      if (!el) return;
      const saved = addresses.getSaved();
      if (!saved.length) { el.innerHTML = ''; return; }
      el.innerHTML = saved.map((a, i) => `
        <button type="button"
          class="zx-saved-addr-btn"
          onclick="ZX.addresses.fillForm(${i}); ${onSelect ? `(${onSelect.toString()})(ZX.addresses.getSaved()[${i}])` : ''}"
          title="Use: ${a.address}, ${a.city}">
          <span class="zx-saved-addr-label">${a.label || (i === 0 ? 'Last used' : 'Previous')}</span>
          <span class="zx-saved-addr-line">${a.address}, ${a.city} — ${a.pincode}</span>
        </button>`).join('');
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS LABELS & COLORS — matches Order.js enum exactly
  // ─────────────────────────────────────────────────────────────────────────
  const STATUS_LABEL = {
    request_sent: 'Request Sent',
    waiting:      'Waiting for Artist',
    accepted:     'Accepted',
    advance_paid: 'Advance Paid',
    in_progress:  'In Progress',
    completed:    'Work Completed',
    shipped:      'Shipped',
    delivered:    'Delivered',
    rejected:     'Declined',
  };

  const STATUS_COLOR = {
    request_sent: '#c8915a',
    waiting:      '#a07c2a',
    accepted:     '#22c55e',
    advance_paid: '#16a34a',
    in_progress:  '#3b82f6',
    completed:    '#8b5cf6',
    shipped:      '#f59e0b',
    delivered:    '#22c55e',
    rejected:     '#e05c5c',
  };

  /**
   * Returns a styled badge HTML string for an order status.
   * @param {string} status
   * @returns {string} HTML string
   */
  const statusBadge = (status) => {
    const label = STATUS_LABEL[status] || status;
    const color = STATUS_COLOR[status] || '#888';
    return `<span class="zx-status-badge" style="
      background:${color}1a;
      color:${color};
      border:1px solid ${color}40;
      border-radius:999px;
      padding:2px 10px;
      font-size:.75rem;
      font-weight:500;
      letter-spacing:.03em;
      white-space:nowrap;
    ">${label}</span>`;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ROUTE GUARD
  // Phase 6 fix: phoneVerified gate added after login check.
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Redirects if the user shouldn't be on the current page.
   * Call on every protected page's script:  ZX.guardRoute('buyer')
   *
   * @param {"buyer"|"artist"|"admin"|null} [requiredRole]
   * @returns {boolean} true if allowed to stay
   */
  const guardRoute = (requiredRole = null) => {
    const user = getUser();

    // ── Not logged in ──
    if (!user || !getToken()) {
      window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
      return false;
    }

    // ── Identity Lock: phone not verified ──
    // Admin is permanently exempt (phoneVerified is forced true on admin accounts).
    if (!user.phoneVerified && user.role !== 'admin') {
      window.location.href = '/phone-verify.html';
      return false;
    }

    // ── Wrong role ──
    if (requiredRole && user.role !== requiredRole) {
      const dashMap = {
        buyer:  '/dashboard-buyer.html',
        artist: '/dashboard-artist.html',
        admin:  '/dashboard-admin.html',
      };
      window.location.href = dashMap[user.role] || '/index.html';
      return false;
    }

    return true;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // NAV AUTH BUILDER
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * Injects sign-in/dashboard nav buttons into a container element.
   * @param {string} containerId
   */
  const buildNavAuth = (containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    const user = getUser();
    if (user) {
      const dash = user.role === 'artist' ? '/dashboard-artist.html'
                 : user.role === 'admin'  ? '/dashboard-admin.html'
                 : '/dashboard-buyer.html';
      el.innerHTML = `
        <a href="${dash}" class="nav-btn">Dashboard</a>
        <button class="nav-btn fill" onclick="ZX.auth.logout()">Sign Out</button>`;
    } else {
      el.innerHTML = `
        <a href="/login.html" class="nav-btn">Sign In</a>
        <a href="/login.html?mode=register" class="nav-btn fill">Join Free</a>`;
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────
  return {
    // Namespaces
    auth,
    artists,
    orders,
    chat,
    reviews,
    admin,
    terms,
    addresses,

    // UI helpers
    STATUS_LABEL,
    STATUS_COLOR,
    statusBadge,
    guardRoute,
    buildNavAuth,

    // Raw access
    getToken,
    getUser,

    // Error class for instanceof checks in catch blocks
    ZXError,
  };
})();
