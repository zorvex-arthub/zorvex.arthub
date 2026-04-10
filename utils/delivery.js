/**
 * utils/delivery.js
 *
 * Shiprocket API integration layer for ZorvEx.
 *
 * Exported functions:
 *   getShiprocketToken()                              — Authenticate & return a cached bearer token
 *   calculateShipping(pickupPincode, deliveryPincode, weight) — Estimate delivery cost
 *   createShipment(order, artistProfile)              — Book a shipment, return tracking details
 *   getTrackingDetails(shiprocketOrderId)             — Poll live tracking status
 *
 * Env vars required:
 *   SHIPROCKET_EMAIL    — Shiprocket account email
 *   SHIPROCKET_PASSWORD — Shiprocket account password
 *
 * Token caching: Shiprocket tokens are valid for 24 hours.
 * We cache in-process and refresh 5 minutes before expiry to avoid
 * any mid-request 401 errors.
 */

const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

/** Default package dimensions (cm) for flat artwork parcels */
const DEFAULT_DIMENSIONS = {
  length: 45,   // cm — fits A2 rolled or framed up to A3
  breadth: 35,  // cm
  height: 5,    // cm
};

/** Fallback shipping fee (₹) when Shiprocket API is unavailable */
const FALLBACK_SHIPPING_FEE = 120;

/** Token expiry buffer in ms — refresh 5 min before the 24-hour mark */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// IN-PROCESS TOKEN CACHE
// Single-process safe; for multi-instance deployments, swap for Redis.
// ─────────────────────────────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;  // Unix timestamp (ms)

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPER: Minimal promise-based HTTPS request
// Avoids adding axios/node-fetch just for a few internal calls.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} method  — HTTP verb: 'GET' | 'POST'
 * @param {string} path    — Path relative to SHIPROCKET_BASE
 * @param {object|null} body  — JSON body (for POST)
 * @param {string|null} token — Bearer token (omit for auth endpoint)
 * @returns {Promise<object>} Parsed JSON response
 */
const shiprocketRequest = (method, path, body = null, token = null) =>
  new Promise((resolve, reject) => {
    const url = new URL(`${SHIPROCKET_BASE}${path}`);
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Shiprocket signals errors both via HTTP status and in body
          if (res.statusCode >= 400) {
            const msg = parsed?.message || parsed?.error || `Shiprocket error ${res.statusCode}`;
            return reject(new Error(msg));
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Failed to parse Shiprocket response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', err => reject(new Error(`Shiprocket network error: ${err.message}`)));
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('Shiprocket request timed out after 10s.'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getShiprocketToken()
// Returns a valid bearer token, fetching a fresh one if needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<string>} Shiprocket bearer token
 */
const getShiprocketToken = async () => {
  // Return cached token if still valid
  if (_cachedToken && Date.now() < _tokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return _cachedToken;
  }

  const email    = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    throw new Error('Shiprocket credentials missing. Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD env vars.');
  }

  const data = await shiprocketRequest('POST', '/auth/login', { email, password });

  if (!data?.token) {
    throw new Error('Shiprocket authentication failed: no token in response.');
  }

  _cachedToken    = data.token;
  // Shiprocket tokens are valid for 24 h; we cache for 23h55m
  _tokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000);

  console.log('✅ Shiprocket token refreshed.');
  return _cachedToken;
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: calculateShipping(pickupPincode, deliveryPincode, weight)
//
// Calls Shiprocket's serviceability check to get the cheapest available rate.
// Falls back to FALLBACK_SHIPPING_FEE if the API is unreachable.
//
// @param {string} pickupPincode   — Artist's pincode (6 digits)
// @param {string} deliveryPincode — Buyer's pincode  (6 digits)
// @param {number} weight          — Package weight in kg (default 0.5)
// @returns {Promise<{ fee: number, carrier: string, estimatedDays: string }>}
// ─────────────────────────────────────────────────────────────────────────────
const calculateShipping = async (pickupPincode, deliveryPincode, weight = 0.5) => {
  const pinRegex = /^\d{6}$/;
  if (!pinRegex.test(pickupPincode) || !pinRegex.test(deliveryPincode)) {
    throw new Error('Both pickup and delivery pincodes must be valid 6-digit Indian PIN codes.');
  }

  const weightKg = Math.max(0.1, parseFloat(weight) || 0.5);

  try {
    const token = await getShiprocketToken();

    const params = new URLSearchParams({
      pickup_postcode:   pickupPincode,
      delivery_postcode: deliveryPincode,
      weight:            weightKg.toString(),
      cod:               '0',   // ZorvEx uses prepaid payments only
      length:            DEFAULT_DIMENSIONS.length.toString(),
      breadth:           DEFAULT_DIMENSIONS.breadth.toString(),
      height:            DEFAULT_DIMENSIONS.height.toString(),
    });

    const data = await shiprocketRequest(
      'GET',
      `/courier/serviceability/?${params.toString()}`,
      null,
      token
    );

    const couriers = data?.data?.available_courier_companies;
    if (!Array.isArray(couriers) || couriers.length === 0) {
      console.warn(`No couriers available for ${pickupPincode} → ${deliveryPincode}. Using fallback.`);
      return { fee: FALLBACK_SHIPPING_FEE, carrier: 'India Post', estimatedDays: '7–10 days' };
    }

    // Sort by rate ascending, pick cheapest
    const cheapest = couriers.sort((a, b) => (a.rate || 0) - (b.rate || 0))[0];

    return {
      fee:           Math.ceil(cheapest.rate || FALLBACK_SHIPPING_FEE),
      carrier:       cheapest.courier_name || 'Standard Courier',
      estimatedDays: cheapest.estimated_delivery_days
        ? `${cheapest.estimated_delivery_days} days`
        : '5–7 days',
    };
  } catch (err) {
    // Non-fatal — caller can still show order form with fallback fee
    console.error('calculateShipping error:', err.message);
    return { fee: FALLBACK_SHIPPING_FEE, carrier: 'India Post', estimatedDays: '7–10 days' };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: createShipment(order, artistProfile)
//
// Books a Shiprocket order/shipment once the artwork is ready to dispatch.
// Returns tracking ID and Shiprocket order ID for storage on the Order doc.
//
// @param {object} order         — Mongoose Order document (populated)
// @param {object} artistProfile — Mongoose ArtistProfile document
// @returns {Promise<{ shiprocketOrderId: string, trackingId: string, carrier: string }>}
// ─────────────────────────────────────────────────────────────────────────────
const createShipment = async (order, artistProfile) => {
  if (order.deliveryType !== 'physical') {
    throw new Error('createShipment should only be called for physical delivery orders.');
  }

  const addr   = order.deliveryAddress;
  const pickup = artistProfile.location;

  if (!addr?.pincode || !addr?.address) {
    throw new Error('Order is missing required delivery address fields.');
  }
  if (!pickup?.pincode) {
    throw new Error('Artist profile is missing pickup pincode. Please complete your profile.');
  }

  const token = await getShiprocketToken();

  // Construct a unique channel order ID using our Order _id
  const channelOrderId = `ZVX-${order._id.toString().slice(-8).toUpperCase()}`;

  // Shiprocket requires items array — represent the artwork as a line item
  const items = [{
    name:         order.category || 'Custom Artwork',
    sku:          order._id.toString().slice(-6),
    units:        1,
    selling_price: order.pricing.totalAmount,
  }];

  const payload = {
    order_id:         channelOrderId,
    order_date:       new Date().toISOString().split('T')[0],
    pickup_location:  'Primary',   // must match a saved pickup location in Shiprocket dashboard

    // ── BILLING (same as delivery for B2C) ──
    billing_customer_name:    addr.name    || 'ZorvEx Buyer',
    billing_last_name:        '',
    billing_address:          addr.address,
    billing_city:             addr.city,
    billing_pincode:          addr.pincode,
    billing_state:            addr.state   || 'Kerala',
    billing_country:          'India',
    billing_email:            order.buyer?.email || '',
    billing_phone:            addr.phone   || order.buyerPhone || '',

    // ── SHIPPING ──
    shipping_is_billing: true,

    // ── ITEMS ──
    order_items:    items,

    // ── PAYMENT ──
    payment_method: 'Prepaid',
    sub_total:      order.pricing.totalAmount,
    length:         DEFAULT_DIMENSIONS.length,
    breadth:        DEFAULT_DIMENSIONS.breadth,
    height:         DEFAULT_DIMENSIONS.height,
    weight:         0.5,   // kg — default for art parcels

    // ── PICKUP ──
    pickup_postcode:   pickup.pincode,
    delivery_postcode: addr.pincode,
  };

  const data = await shiprocketRequest('POST', '/orders/create/adhoc', payload, token);

  if (!data?.order_id) {
    throw new Error('Shiprocket did not return an order_id. Shipment may not have been created.');
  }

  // Assign a courier (auto-assign by Shiprocket)
  let trackingId = null;
  let carrier    = 'Standard Courier';

  try {
    const assignRes = await shiprocketRequest(
      'POST',
      '/courier/assign/awb',
      { shipment_id: data.shipment_id },
      token
    );
    trackingId = assignRes?.response?.data?.awb_code || null;
    carrier    = assignRes?.response?.data?.courier_name || carrier;
  } catch (assignErr) {
    // Non-fatal — shipment is created, AWB can be assigned later via dashboard
    console.warn('AWB auto-assignment failed (can retry from dashboard):', assignErr.message);
  }

  // Schedule courier pickup
  try {
    await shiprocketRequest(
      'POST',
      '/courier/generate/pickup',
      { shipment_id: [data.shipment_id] },
      token
    );
  } catch (pickupErr) {
    console.warn('Pickup scheduling failed (retry from dashboard):', pickupErr.message);
  }

  return {
    shiprocketOrderId:  data.order_id.toString(),
    shiprocketShipmentId: data.shipment_id?.toString() || null,
    trackingId:         trackingId || 'PENDING',
    carrier,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: getTrackingDetails(shiprocketOrderId)
//
// Returns live tracking status for a shipped order.
// @param {string} shiprocketOrderId — Shiprocket order_id stored on Order.shipping
// @returns {Promise<object>} Raw tracking data from Shiprocket
// ─────────────────────────────────────────────────────────────────────────────
const getTrackingDetails = async (shiprocketOrderId) => {
  if (!shiprocketOrderId) {
    throw new Error('shiprocketOrderId is required.');
  }

  const token = await getShiprocketToken();
  const data  = await shiprocketRequest(
    'GET',
    `/courier/track?order_id=${encodeURIComponent(shiprocketOrderId)}`,
    null,
    token
  );

  return data?.tracking_data || data || {};
};

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  getShiprocketToken,
  calculateShipping,
  createShipment,
  getTrackingDetails,
};
