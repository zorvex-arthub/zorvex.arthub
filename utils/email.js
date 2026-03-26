const nodemailer = require('nodemailer');

// ── TRANSPORTER ──
const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.MAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// ── SEND EMAIL ──
const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM || 'ZorvEx <zorvexinfo@gmail.com>',
      to,
      subject,
      html
    });
    console.log('[Email] Sent to', to, '| MessageId:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[Email] Failed:', err.message);
    return { success: false, error: err.message };
  }
};

// ─────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
// Note: "Notifications & updates will be informed through email."
// ─────────────────────────────────────────────────────────────

const BASE_STYLE = `
  font-family: 'Georgia', serif;
  background: #0d0d0d;
  color: #f5f0e8;
  max-width: 600px;
  margin: 0 auto;
  border: 1px solid rgba(201,168,76,.2);
`;

const GOLD = '#c9a84c';

// ── 1. ORDER CONFIRMATION (to Buyer) ──
exports.sendOrderConfirmation = async (buyer, order) => {
  return sendEmail({
    to: buyer.email,
    subject: `ZorvEx — Commission Request Received (#${order._id.toString().slice(-8).toUpperCase()})`,
    html: `
    <div style="${BASE_STYLE} padding: 32px;">
      <h1 style="color:${GOLD}; font-size:24px; margin-bottom:4px;">ZORVEX</h1>
      <p style="color:#888; font-size:12px; letter-spacing:3px; text-transform:uppercase; margin-bottom:24px;">Art Marketplace</p>
      <h2 style="font-size:18px; margin-bottom:16px;">Commission Request Confirmed ✓</h2>
      <p style="color:#aaa; line-height:1.8; font-size:14px;">
        Hi <strong style="color:#f5f0e8">${buyer.name}</strong>,<br><br>
        Your commission request has been received and is under admin review.
        Once forwarded to the artist and accepted, you'll receive a payment link.
      </p>
      <div style="background:#1a1710; border:1px solid rgba(201,168,76,.15); padding:16px; margin:20px 0;">
        <p style="font-size:12px; color:#888; letter-spacing:2px; text-transform:uppercase; margin-bottom:8px;">Order Details</p>
        <p style="font-size:13px; color:#f5f0e8;">Order ID: <strong>#${order._id.toString().slice(-8).toUpperCase()}</strong></p>
        <p style="font-size:13px; color:#f5f0e8;">Category: <strong>${order.category}</strong></p>
        <p style="font-size:13px; color:#f5f0e8;">Total: <strong style="color:${GOLD}">₹${order.pricing.totalAmount}</strong></p>
        <p style="font-size:13px; color:#f5f0e8;">Advance (50%): <strong style="color:${GOLD}">₹${order.pricing.advanceAmount}</strong></p>
      </div>
      <p style="font-size:12px; color:#666; margin-top:24px; border-top:1px solid #222; padding-top:16px;">
        📧 Notifications & updates will be informed through email.<br>
        ZorvEx · zorvexinfo@gmail.com · +91 9946301939
      </p>
    </div>`
  });
};

// ── 2. ORDER ACCEPTED (to Buyer — prompt advance payment) ──
exports.sendOrderAccepted = async (buyer, order) => {
  return sendEmail({
    to: buyer.email,
    subject: `ZorvEx — Artist Accepted Your Commission! Pay Advance Now`,
    html: `
    <div style="${BASE_STYLE} padding: 32px;">
      <h1 style="color:${GOLD}; font-size:24px; margin-bottom:4px;">ZORVEX</h1>
      <h2 style="font-size:18px; margin:20px 0 12px;">🎉 Your Commission Was Accepted!</h2>
      <p style="color:#aaa; line-height:1.8; font-size:14px;">
        Hi <strong style="color:#f5f0e8">${buyer.name}</strong>, the artist has accepted your commission.<br>
        Please pay the 50% advance of <strong style="color:${GOLD}">₹${order.pricing.advanceAmount}</strong> to begin the work.
      </p>
      <p style="font-size:12px; color:#666; margin-top:24px;">
        📧 Notifications & updates will be informed through email.<br>
        ZorvEx · zorvexinfo@gmail.com
      </p>
    </div>`
  });
};

// ── 3. SHIPPING WITH TRACKING (to Buyer) ──
exports.sendShippingUpdate = async (buyer, order) => {
  return sendEmail({
    to: buyer.email,
    subject: `ZorvEx — Your Order Has Been Shipped! 📦`,
    html: `
    <div style="${BASE_STYLE} padding: 32px;">
      <h1 style="color:${GOLD}; font-size:24px; margin-bottom:4px;">ZORVEX</h1>
      <h2 style="font-size:18px; margin:20px 0 12px;">📦 Your Order Is On Its Way!</h2>
      <p style="color:#aaa; line-height:1.8; font-size:14px;">
        Hi <strong style="color:#f5f0e8">${buyer.name}</strong>,<br>
        Your artwork has been shipped via <strong>${order.shipping.carrier || 'India Post'}</strong>.
      </p>
      <div style="background:#1a1710; border:1px solid rgba(245,158,11,.2); padding:16px; margin:20px 0;">
        <p style="font-size:12px; color:#f59e0b; letter-spacing:2px; text-transform:uppercase; margin-bottom:8px;">Tracking Details</p>
        <p style="font-size:15px; color:#f5f0e8; font-weight:bold;">Tracking ID: ${order.shipping.trackingId}</p>
        <p style="font-size:12px; color:#aaa; margin-top:6px;">Track on <a href="https://www.indiapost.gov.in" style="color:${GOLD}">indiapost.gov.in</a></p>
      </div>
      <p style="font-size:12px; color:#666; margin-top:24px;">
        📧 Notifications & updates will be informed through email.<br>
        ZorvEx · zorvexinfo@gmail.com
      </p>
    </div>`
  });
};

// ── 4. PICKUP READY — notify Admin ──
exports.sendPickupReadyToAdmin = async (adminEmail, artist, order) => {
  return sendEmail({
    to: adminEmail,
    subject: `ZorvEx Admin — Artist Artwork Ready for Pickup`,
    html: `
    <div style="${BASE_STYLE} padding: 32px;">
      <h1 style="color:${GOLD}; font-size:24px; margin-bottom:4px;">ZORVEX ADMIN</h1>
      <h2 style="font-size:18px; margin:20px 0 12px;">🎨 Artwork Ready for Pickup</h2>
      <div style="background:#1a1710; border:1px solid rgba(201,168,76,.15); padding:16px; margin:16px 0;">
        <p style="font-size:13px; color:#f5f0e8;">Artist: <strong>${artist.name}</strong></p>
        <p style="font-size:13px; color:#f5f0e8;">Order ID: <strong>#${order._id.toString().slice(-8).toUpperCase()}</strong></p>
        <p style="font-size:13px; color:#f5f0e8;">Pickup Address: <strong>${order.artistPickupAddress || 'See admin dashboard'}</strong></p>
      </div>
      <p style="font-size:12px; color:#aaa;">Schedule Shiprocket pickup from the admin dashboard.</p>
    </div>`
  });
};

module.exports.sendEmail = sendEmail;
