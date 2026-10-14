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

// ---- 備品管理アプリへのシングルサインオン(SSO)用チケット発行。POST /api/config (Hobbyプランの関数数上限12のため同居) ----
// 旧: POST /api/sso { auth:{name,password} }
// → { url: "<備品管理アプリのURL>/?sso=<60秒だけ有効な署名付きチケット>" }
// チケットは「この氏名の人が現場管理アプリにログイン済み」という証明で、備品管理アプリ側(/api/sso)が検証し、
// 借受者台帳の同じ氏名（1人だけ一致した場合）のアカウントでログインさせます。パスワード等は含みません。
// 必要な環境変数（現場管理・備品管理の両方に、同じ値で登録）: SSO_SECRET（任意の長いランダム文字列）
// 任意: BIHIN_URL（既定 https://bihinkanriapp.vercel.app）
var crypto = require("crypto");
var F = require("./_freee");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function b64u(buf){ return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function makeTicket(name, secret){
  var payload = b64u(JSON.stringify({n: name, exp: Date.now() + 60000, j: crypto.randomBytes(6).toString("hex")}));
  var sig = b64u(crypto.createHmac("sha256", secret).update(payload).digest());
  return payload + "." + sig;
}


async function ssoHandler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    var secret = F.env("SSO_SECRET");
    if(!secret || secret.length < 16) return res.status(200).json({error: "notconfigured"});
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    var base = (F.env("BIHIN_URL") || "https://bihinkanriapp.vercel.app").replace(/\/+$/, "");
    return res.status(200).json({url: base + "/?sso=" + makeTicket(me.name, secret)});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
}

module.exports = async function handler(req, res) {
  if(req.method === "POST") return ssoHandler(req, res);

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
module.exports.makeTicket = makeTicket;
