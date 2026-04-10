/**
 * config/firebase.js
 * Initializes Firebase Admin SDK.
 * Credentials come from environment variable FIREBASE_SERVICE_ACCOUNT (JSON string)
 * OR from individual env vars if you prefer.
 *
 * On Render: set FIREBASE_SERVICE_ACCOUNT as a secret env variable
 * containing the full serviceAccountKey.json content as a single-line JSON string.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  let serviceAccount;

  try {
    // Preferred: single env var with full JSON
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    // Fallback: individual vars (useful for some hosting providers)
    serviceAccount = {
      type:                        'service_account',
      project_id:                  process.env.FIREBASE_PROJECT_ID,
      private_key_id:              process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key:                 (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      client_email:                process.env.FIREBASE_CLIENT_EMAIL,
      client_id:                   process.env.FIREBASE_CLIENT_ID,
      auth_uri:                    'https://accounts.google.com/o/oauth2/auth',
      token_uri:                   'https://oauth2.googleapis.com/token',
    };
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log('✅ Firebase Admin initialized');
}

module.exports = admin;
