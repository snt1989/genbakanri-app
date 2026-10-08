// freee会計 連携の共通処理（Vercel Serverless Functions）。
//
// 必要な環境変数（Vercel > Settings > Environment Variables）:
//   FREEE_CLIENT_ID      freeeアプリストアで作成したアプリの Client ID
//   FREEE_CLIENT_SECRET  同 Client Secret
//   FREEE_TOKEN_KEY      任意の長いランダム文字列（トークンの暗号化とOAuthのstate署名に使用）
//   FIREBASE_PROJECT_ID / FIREBASE_API_KEY  既存（/api/config と同じ）
//   FREEE_REDIRECT_URI   任意。未設定なら https://<ホスト>/api/freee-callback
//
// セキュリティ: このアプリのFirestoreルールは公開設定のため、アクセストークンは
// FREEE_TOKEN_KEY でAES-256-GCM暗号化してから保存します（鍵が無ければ読めません）。
// APIは「管理者の氏名＋ログインパスワード」を毎回サーバー側で照合します。
var crypto = require("crypto");

var AUTH_BASE = "https://accounts.secure.freee.co.jp/public_api";
var API_BASE = "https://api.freee.co.jp";

function env(n){ return String(process.env[n] || "").trim().replace(/^["']+|["']+$/g, ""); }
function configured(){ return !!(env("FREEE_CLIENT_ID") && env("FREEE_CLIENT_SECRET") && env("FREEE_TOKEN_KEY") && env("FIREBASE_PROJECT_ID") && env("FIREBASE_API_KEY")); }
function redirectUri(req){
  if(env("FREEE_REDIRECT_URI")) return env("FREEE_REDIRECT_URI");
  var host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return "https://" + host + "/api/freee-callback";
}

/* ---- 暗号化 / 署名 ---- */
function key32(){ return crypto.createHash("sha256").update(env("FREEE_TOKEN_KEY")).digest(); }
function encrypt(obj){
  var iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key32(), iv);
  var enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(b64){
  var buf = Buffer.from(b64, "base64");
  var d = crypto.createDecipheriv("aes-256-gcm", key32(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}
function sign(s){ return crypto.createHmac("sha256", key32()).update(s).digest("hex"); }
function safeEq(a, b){
  var x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function makeState(){ var p = crypto.randomBytes(8).toString("hex") + "." + Date.now(); return p + "." + sign(p); }
function checkState(st){
  var parts = String(st || "").split(".");
  if(parts.length !== 3) return false;
  var p = parts[0] + "." + parts[1];
  return safeEq(sign(p), parts[2]) && Date.now() - Number(parts[1]) < 15 * 60 * 1000;
}

/* ---- Firestore REST（公開ルール前提） ---- */
function fsBase(){ return "https://firestore.googleapis.com/v1/projects/" + env("FIREBASE_PROJECT_ID") + "/databases/(default)/documents"; }
function fsVal(v){
  if(v == null) return null;
  if("stringValue" in v) return v.stringValue;
  if("booleanValue" in v) return v.booleanValue;
  if("integerValue" in v) return Number(v.integerValue);
  if("doubleValue" in v) return v.doubleValue;
  return null;
}
async function fsGet(path){
  var r = await fetch(fsBase() + "/" + path + "?key=" + encodeURIComponent(env("FIREBASE_API_KEY")));
  if(r.status === 404) return null;
  if(!r.ok) throw new Error("firestore " + r.status);
  var j = await r.json(), o = {};
  Object.keys(j.fields || {}).forEach(function(k){ o[k] = fsVal(j.fields[k]); });
  return o;
}
async function fsSet(path, data){
  var fields = {};
  Object.keys(data).forEach(function(k){ fields[k] = {stringValue: String(data[k])}; });
  var r = await fetch(fsBase() + "/" + path + "?key=" + encodeURIComponent(env("FIREBASE_API_KEY")), {method:"PATCH", headers:{"Content-Type":"application/json"}, body: JSON.stringify({fields: fields})});
  if(!r.ok) throw new Error("firestore " + r.status);
}
async function fsDelete(path){
  await fetch(fsBase() + "/" + path + "?key=" + encodeURIComponent(env("FIREBASE_API_KEY")), {method:"DELETE"});
}
async function listMembers(){
  var out = [], token = "";
  for(var i = 0; i < 10; i++){
    var r = await fetch(fsBase() + "/members?pageSize=300&key=" + encodeURIComponent(env("FIREBASE_API_KEY")) + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    if(!r.ok) throw new Error("firestore " + r.status);
    var j = await r.json();
    (j.documents || []).forEach(function(d){ var o = {}; Object.keys(d.fields || {}).forEach(function(k){ o[k] = fsVal(d.fields[k]); }); out.push(o); });
    token = j.nextPageToken || ""; if(!token) break;
  }
  return out;
}
// メンバーの氏名とログインパスワードを照合する（一致すればメンバー情報、なければnull）
async function verifyMember(name, password){
  if(!name || !password) return null;
  var strip = function(s){ return String(s || "").replace(/[\s　]+/g, ""); };
  var list = await listMembers();
  return list.find(function(x){ return strip(x.name) === strip(name) && x.password != null && safeEq(x.password, password); }) || null;
}
function isAdminMember(m){ return !!(m && (m.permission === "admin" || (!m.permission && m.isAdmin === true))); }
// 管理者の氏名とログインパスワードを照合する
async function verifyAdmin(name, password){ return isAdminMember(await verifyMember(name, password)); }

/* ---- freee トークン ---- */
async function tokenRequest(params){
  var body = new URLSearchParams(Object.assign({client_id: env("FREEE_CLIENT_ID"), client_secret: env("FREEE_CLIENT_SECRET")}, params));
  var r = await fetch(AUTH_BASE + "/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body: body.toString()});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok || !j.access_token) throw new Error("freee token: " + (j.error_description || j.error || r.status));
  return {access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 21600) * 1000 - 60000};
}
async function saveTokens(t, extra){
  var cur = (await loadTokens()) || {};
  await fsSet("settings/freeeAuth", {enc: encrypt(Object.assign({}, cur, t, extra || {})), updatedAt: new Date().toISOString()});
}
async function loadTokens(){
  var d = await fsGet("settings/freeeAuth");
  if(!d || !d.enc) return null;
  try{ return decrypt(d.enc); }catch(e){ return null; }
}
async function exchangeCode(code, redirect){ return tokenRequest({grant_type:"authorization_code", code: code, redirect_uri: redirect}); }
async function getAccess(){
  var t = await loadTokens();
  if(!t) throw httpErr(409, "freeeと連携されていません");
  if(Date.now() < t.expires_at) return t;
  var n = await tokenRequest({grant_type:"refresh_token", refresh_token: t.refresh_token});
  await saveTokens(n);
  return Object.assign({}, t, n);
}
function httpErr(status, message){ var e = new Error(message); e.status = status; return e; }

async function freee(method, path, opts){
  opts = opts || {};
  var t = await getAccess();
  var url = API_BASE + path;
  if(opts.query){ url += (path.indexOf("?") === -1 ? "?" : "&") + new URLSearchParams(opts.query).toString(); }
  var r = await fetch(url, {method: method, headers: Object.assign({Authorization: "Bearer " + t.access_token, "X-Api-Version": "2020-06-15"}, opts.body ? {"Content-Type":"application/json"} : {}), body: opts.body ? JSON.stringify(opts.body) : undefined});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok){
    var msg = (j.message) || (j.errors && j.errors.map(function(e){ return (e.messages || []).join(" "); }).join(" / ")) || ("freee API " + r.status);
    throw httpErr(r.status === 401 ? 401 : 502, msg);
  }
  return j;
}

module.exports = {configured: configured, redirectUri: redirectUri, AUTH_BASE: AUTH_BASE, env: env, makeState: makeState, checkState: checkState,
  verifyAdmin: verifyAdmin, verifyMember: verifyMember, isAdminMember: isAdminMember, safeEq: safeEq, exchangeCode: exchangeCode, saveTokens: saveTokens, loadTokens: loadTokens, fsDelete: fsDelete, freee: freee, httpErr: httpErr};
