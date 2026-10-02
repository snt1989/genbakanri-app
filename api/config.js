// Serves the Firebase web config to the standalone (Vercel) deployment of
// the app. The actual values live in Vercel's Environment Variables
// (FIREBASE_API_KEY / FIREBASE_AUTH_DOMAIN / FIREBASE_PROJECT_ID /
// FIREBASE_STORAGE_BUCKET / FIREBASE_MESSAGING_SENDER_ID / FIREBASE_APP_ID)
// rather than in this repository, so they can be rotated without a code
// change.
//
// Note: a Firebase web config is not a secret -- Firebase's own docs say
// it is safe to expose in client-side code, since access is controlled by
// Firestore Security Rules rather than by hiding this object. This app's
// rules are intentionally open (see the setup notes shared with the
// project owner), matching how this app already has no server-side
// authentication of its own.
module.exports = function handler(req, res) {
  var cfg = {
    apiKey: process.env.FIREBASE_API_KEY || null,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || null,
    projectId: process.env.FIREBASE_PROJECT_ID || null,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || null,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || null,
    appId: process.env.FIREBASE_APP_ID || null
  };
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(cfg);
};
