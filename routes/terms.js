/**
 * routes/terms.js
 * GET /api/terms          — Terms & Conditions (JSON or HTML)
 * GET /api/terms/privacy  — Privacy Policy
 * GET /api/terms/refund   — Refund Policy
 *
 * These are served as structured JSON so your frontend can render them
 * in your Empire design. All content is ZorvEx-specific.
 */

const router = require('express').Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/terms
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', (_req, res) => {
  res.json({
    title:       'Terms & Conditions',
    platform:    'ZorvEx',
    lastUpdated: '2025-01-01',
    contact:     'zorvexinfo@gmail.com',
    sections: [
      {
        id:      'acceptance',
        heading: '1. Acceptance of Terms',
        body:    'By accessing or using ZorvEx ("Platform"), you agree to be bound by these Terms & Conditions. If you disagree with any part, you may not use the Platform.',
      },
      {
        id:      'eligibility',
        heading: '2. Eligibility',
        body:    'You must be at least 18 years of age or have parental consent to use ZorvEx. By registering, you represent that all information provided is accurate and truthful.',
      },
      {
        id:      'roles',
        heading: '3. User Roles',
        body:    'ZorvEx has three user roles: Buyers (commission artwork), Artists (accept and fulfil commissions), and Admin (platform management). Roles are set at registration and cannot be changed by users.',
      },
      {
        id:      'orders',
        heading: '4. Orders & Commissions',
        body:    'All custom artwork orders are subject to artist availability. An order is confirmed only after the artist accepts the request and the buyer pays the advance (50% of total). ZorvEx charges a 10% platform commission on each order.',
      },
      {
        id:      'payments',
        heading: '5. Payments',
        body:    'Payments are processed via Razorpay. The advance (50%) is collected before work begins. The remaining 50% is collected upon completion. ZorvEx does not store card or UPI details.',
      },
      {
        id:      'delivery',
        heading: '6. Delivery',
        body:    'Physical artworks are shipped via India Post or Shiprocket. Estimated delivery is 7–14 business days after dispatch. Digital artworks are delivered in-app as a one-time secure download.',
      },
      {
        id:      'cancellation',
        heading: '7. Cancellation',
        body:    'Orders cannot be cancelled after the advance payment is made. Prior to advance payment, either party may cancel without penalty. ZorvEx reserves the right to cancel orders that violate platform policies.',
      },
      {
        id:      'ip',
        heading: '8. Intellectual Property',
        body:    'Artists retain copyright of their original work unless explicitly transferred in writing. ZorvEx does not claim ownership of any artwork created through the Platform. Buyers receive a personal-use licence unless otherwise agreed.',
      },
      {
        id:      'conduct',
        heading: '9. Prohibited Conduct',
        body:    'Users must not: engage in fraud, misrepresent artwork, harass other users, attempt to bypass Platform payments, or use the Platform for unlawful purposes. Violations may result in immediate account suspension and legal action.',
      },
      {
        id:      'blacklist',
        heading: '10. Account Suspension & Blacklisting',
        body:    'ZorvEx reserves the right to suspend or permanently blacklist accounts, email addresses, phone numbers, or IP addresses involved in fraudulent, abusive, or dishonest activity.',
      },
      {
        id:      'liability',
        heading: '11. Limitation of Liability',
        body:    'ZorvEx acts as a marketplace and is not responsible for disputes between buyers and artists beyond our stated refund and mediation policies. Our liability is limited to the platform commission collected on the specific transaction in dispute.',
      },
      {
        id:      'changes',
        heading: '12. Changes to Terms',
        body:    'ZorvEx may update these Terms at any time. Continued use of the Platform after changes constitutes acceptance of the updated Terms.',
      },
      {
        id:      'governing',
        heading: '13. Governing Law',
        body:    'These Terms are governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of courts in Kerala, India.',
      },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/terms/privacy
// ─────────────────────────────────────────────────────────────────────────────
router.get('/privacy', (_req, res) => {
  res.json({
    title:       'Privacy Policy',
    platform:    'ZorvEx',
    lastUpdated: '2025-01-01',
    contact:     'zorvexinfo@gmail.com',
    sections: [
      {
        id:      'collect',
        heading: '1. Information We Collect',
        body:    'We collect: name, email, phone number, delivery addresses, profile information (for artists), order history, and payment transaction IDs. We do not store raw card or UPI data.',
      },
      {
        id:      'use',
        heading: '2. How We Use Your Data',
        body:    'Your data is used to: process orders, facilitate payments, communicate order updates, improve Platform features, and prevent fraud.',
      },
      {
        id:      'sharing',
        heading: '3. Data Sharing',
        body:    'We do not sell your personal data. Delivery addresses are shared with our logistics partner (Shiprocket / India Post) only for order fulfilment. Artist names and portfolio images are publicly visible.',
      },
      {
        id:      'google',
        heading: '4. Google Sign-In',
        body:    'If you sign in with Google, we receive your name, email, and profile photo from Google. We do not access your Google contacts, drive, or any other data beyond authentication.',
      },
      {
        id:      'retention',
        heading: '5. Data Retention',
        body:    'Account data is retained while your account is active. You may request deletion by emailing zorvexinfo@gmail.com. Order records may be retained for up to 3 years for legal and tax compliance.',
      },
      {
        id:      'rights',
        heading: '6. Your Rights',
        body:    'You have the right to access, correct, or delete your personal data. Contact us at zorvexinfo@gmail.com for any data requests.',
      },
    ],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/terms/refund
// ─────────────────────────────────────────────────────────────────────────────
router.get('/refund', (_req, res) => {
  res.json({
    title:       'Refund Policy',
    platform:    'ZorvEx',
    lastUpdated: '2025-01-01',
    contact:     'zorvexinfo@gmail.com',
    sections: [
      {
        id:      'advance',
        heading: '1. Advance Payment',
        body:    'The 50% advance is non-refundable once the artist has started work. If the artist declines the order before starting, the full advance is refunded within 5–7 business days.',
      },
      {
        id:      'artist_decline',
        heading: '2. Artist Declines Order',
        body:    'If an artist declines your order, 100% of the advance (if paid) is refunded.',
      },
      {
        id:      'final',
        heading: '3. Final Payment',
        body:    'The remaining 50% payment is due on order completion. Disputes about artwork quality must be raised within 48 hours of delivery via the in-app chat.',
      },
      {
        id:      'digital',
        heading: '4. Digital Deliveries',
        body:    'Digital artwork files are non-refundable once downloaded. The file is available for a single secure download.',
      },
      {
        id:      'shipping',
        heading: '5. Shipping Damage',
        body:    'In the event of shipping damage, please contact us within 48 hours with photographic evidence. We will coordinate with the artist and logistics partner to resolve the issue.',
      },
    ],
  });
});

module.exports = router;
