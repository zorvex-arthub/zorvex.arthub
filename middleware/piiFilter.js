// ─── PII Filter Middleware & Utility ──────────────────────────────────────
// Detects: phone numbers, emails, Instagram handles
// Used in: chat routes (backend enforcement)

const PHONE_REGEX = /(\+?91[-.\s]?)?[6-9]\d{9}/g;
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const INSTAGRAM_REGEX = /@[a-zA-Z0-9._]{1,30}/g;
const LINK_REGEX = /(https?:\/\/|www\.)[^\s]+/gi;
// Extra: spelled-out phone patterns like "nine nine zero..."
const SPELLED_PHONE = /\b(zero|one|two|three|four|five|six|seven|eight|nine)(\s+(zero|one|two|three|four|five|six|seven|eight|nine)){5,}\b/gi;

/**
 * Scrubs PII from a text string.
 * Returns { clean, piiDetected }
 */
const scrubPII = (text) => {
  let piiDetected = false;
  let clean = text;

  const check = (regex, replacement) => {
    if (regex.test(clean)) {
      piiDetected = true;
      clean = clean.replace(regex, replacement);
    }
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;
  };

  check(PHONE_REGEX, "[PHONE RESTRICTED]");
  check(EMAIL_REGEX, "[EMAIL RESTRICTED]");
  check(LINK_REGEX, "[LINK RESTRICTED]");
  check(INSTAGRAM_REGEX, "[HANDLE RESTRICTED]");
  check(SPELLED_PHONE, "[CONTACT RESTRICTED]");

  return { clean, piiDetected };
};

/**
 * Middleware to check if chat message body contains PII.
 * Attaches scrubbed text to req.body.text and sets req.piiDetected.
 */
const filterChatMessage = (req, res, next) => {
  if (!req.body.text) return next();

  const { clean, piiDetected } = scrubPII(req.body.text);
  req.body.text = clean;
  req.piiDetected = piiDetected;
  next();
};

module.exports = { scrubPII, filterChatMessage };
