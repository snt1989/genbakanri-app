// Serves the Supabase connection info to the standalone (Vercel) deployment
// of the app. The actual URL/anon key live in Vercel's Environment
// Variables (SUPABASE_URL / SUPABASE_ANON_KEY) rather than in this
// repository, so they can be rotated without a code change.
//
// Note: the Supabase "anon" key is designed to be exposed to browsers --
// that is how every client-side Supabase app works. It is not a secret on
// the level of a database password or a service_role key.
module.exports = function handler(req, res) {
  var url = process.env.SUPABASE_URL || null;
  var anonKey = process.env.SUPABASE_ANON_KEY || null;
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ url: url, anonKey: anonKey });
};
