// LINE WORKS 連携の共通処理（Vercel Serverless Functions）。
//
// 必要な環境変数（Vercel > Settings > Environment Variables）:
//   WORKS_CLIENT_ID        LINE WORKS Developer Console のアプリの Client ID
//   WORKS_CLIENT_SECRET    同 Client Secret
//   WORKS_SERVICE_ACCOUNT  同 Service Account（例: abc12.serviceaccount@your-domain）
//   WORKS_PRIVATE_KEY      同 Private Key（PEM。改行は \n のままでも可）
//   WORKS_BOT_ID           Bot の ID
//   WORKS_BOT_SECRET       Bot の Signing Secret（受信の署名検証に使用。LINE WORKSからの登録・照会を使う場合に必要）
//   CRON_SECRET            毎朝の自動通知用の任意の長い文字列（Vercelが自動で付与して呼び出す）
//   FIREBASE_PROJECT_ID / FIREBASE_API_KEY  既存
//
// セキュリティ: アプリのAPIは「メンバーの氏名＋ログインパスワード」を毎回サーバー側で照合します。
// LINE WORKS から来る Webhook は X-WORKS-Signature（HMAC-SHA256）で署名を検証します。
var crypto = require("crypto");
var F = require("./_freee");

var AUTH_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
var API = "https://www.worksapis.com/v1.0";
var env = F.env;

function configured(){
  return !!(env("WORKS_CLIENT_ID") && env("WORKS_CLIENT_SECRET") && env("WORKS_SERVICE_ACCOUNT") && env("WORKS_PRIVATE_KEY") && env("WORKS_BOT_ID") && env("FIREBASE_PROJECT_ID") && env("FIREBASE_API_KEY"));
}
function httpErr(status, message){ var e = new Error(message); e.status = status; return e; }
function b64url(b){ return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

/* ---- アクセストークン（サービスアカウントのJWT認証。メモリに短時間キャッシュ） ---- */
var cache = {token: "", exp: 0};
async function getToken(){
  if(cache.token && Date.now() < cache.exp) return cache.token;
  var now = Math.floor(Date.now() / 1000);
  var head = b64url(JSON.stringify({alg: "RS256", typ: "JWT"}));
  var claim = b64url(JSON.stringify({iss: env("WORKS_CLIENT_ID"), sub: env("WORKS_SERVICE_ACCOUNT"), iat: now, exp: now + 3600}));
  var key = String(process.env.WORKS_PRIVATE_KEY || "").trim().replace(/^["']+|["']+$/g, "").replace(/\\n/g, "\n");
  var sig;
  try{ sig = b64url(crypto.sign("RSA-SHA256", Buffer.from(head + "." + claim), key)); }
  catch(e){ throw httpErr(500, "WORKS_PRIVATE_KEY を読み取れません（PEM形式か確認してください）"); }
  var body = new URLSearchParams({assertion: head + "." + claim + "." + sig, grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: env("WORKS_CLIENT_ID"), client_secret: env("WORKS_CLIENT_SECRET"), scope: "bot"});
  var r = await fetch(AUTH_URL, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: body.toString()});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok || !j.access_token) throw httpErr(502, "LINE WORKS 認証に失敗: " + (j.error_description || j.error || r.status));
  cache = {token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 120000};
  return cache.token;
}

/* ---- メッセージ送信（text） ---- */
function clip(t){ t = String(t == null ? "" : t); return t.length > 1900 ? t.slice(0, 1890) + "\n…（省略）" : t; }
async function post(path, content){
  var tk = await getToken();
  var r = await fetch(API + path, {method: "POST", headers: {Authorization: "Bearer " + tk, "Content-Type": "application/json"}, body: JSON.stringify({content: content})});
  if(!r.ok){
    var j = await r.json().catch(function(){ return {}; });
    throw httpErr(502, "LINE WORKS 送信に失敗（" + r.status + "）: " + (j.description || j.message || j.code || ""));
  }
}
function sendChannel(channelId, text){ return post("/bots/" + encodeURIComponent(env("WORKS_BOT_ID")) + "/channels/" + encodeURIComponent(channelId) + "/messages", {type: "text", text: clip(text)}); }
function sendUser(userId, text){ return post("/bots/" + encodeURIComponent(env("WORKS_BOT_ID")) + "/users/" + encodeURIComponent(userId) + "/messages", {type: "text", text: clip(text)}); }

/* ---- Firestore REST（型付き） ---- */
function fsBase(){ return "https://firestore.googleapis.com/v1/projects/" + env("FIREBASE_PROJECT_ID") + "/databases/(default)/documents"; }
function keyQ(){ return "key=" + encodeURIComponent(env("FIREBASE_API_KEY")); }
function enc(v){
  if(v === null || v === undefined) return {nullValue: null};
  if(typeof v === "boolean") return {booleanValue: v};
  if(typeof v === "number") return Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v};
  if(Array.isArray(v)) return {arrayValue: {values: v.map(enc)}};
  if(typeof v === "object"){ var f = {}; Object.keys(v).forEach(function(k){ f[k] = enc(v[k]); }); return {mapValue: {fields: f}}; }
  return {stringValue: String(v)};
}
function dec(v){
  if(!v) return null;
  if("stringValue" in v) return v.stringValue;
  if("booleanValue" in v) return v.booleanValue;
  if("integerValue" in v) return Number(v.integerValue);
  if("doubleValue" in v) return v.doubleValue;
  if("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if("mapValue" in v){ var o = {}; Object.keys(v.mapValue.fields || {}).forEach(function(k){ o[k] = dec(v.mapValue.fields[k]); }); return o; }
  return null;
}
function decDoc(d){
  var o = {}; Object.keys(d.fields || {}).forEach(function(k){ o[k] = dec(d.fields[k]); });
  o.id = String(d.name || "").split("/").pop();
  return o;
}
async function getDoc(path){
  var r = await fetch(fsBase() + "/" + path + "?" + keyQ());
  if(r.status === 404) return {};
  if(!r.ok) throw httpErr(502, "firestore " + r.status);
  return decDoc(await r.json());
}
async function listDocs(col){
  var out = [], token = "";
  for(var i = 0; i < 20; i++){
    var r = await fetch(fsBase() + "/" + col + "?pageSize=300&" + keyQ() + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
    if(!r.ok) throw httpErr(502, "firestore " + r.status);
    var j = await r.json();
    (j.documents || []).forEach(function(d){ out.push(decDoc(d)); });
    token = j.nextPageToken || ""; if(!token) break;
  }
  return out;
}
// 指定したフィールドだけ更新（data に無い mask のキーは削除）
async function patchDoc(path, data, removeKeys){
  var fields = {}; Object.keys(data).forEach(function(k){ fields[k] = enc(data[k]); });
  var keys = Object.keys(data).concat(removeKeys || []);
  if(!keys.length) return;   // マスクなしのPATCHは文書全体を置き換えてしまうため何もしない
  var q = keys.map(function(k){ return "updateMask.fieldPaths=" + encodeURIComponent(k); }).join("&");
  var r = await fetch(fsBase() + "/" + path + "?" + (q ? q + "&" : "") + keyQ(), {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({fields: fields})});
  if(!r.ok) throw httpErr(502, "firestore " + r.status);
}
async function createDoc(col, data){
  var fields = {}; Object.keys(data).forEach(function(k){ fields[k] = enc(data[k]); });
  var r = await fetch(fsBase() + "/" + col + "?" + keyQ(), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({fields: fields})});
  if(!r.ok) throw httpErr(502, "firestore " + r.status);
  var j = await r.json().catch(function(){ return {}; });
  return String(j.name || "").split("/").pop();
}

/* ---- 設定・連携ひも付け ---- */
async function getSettings(){ return await getDoc("settings/works"); }
function userKey(userId){ return "u_" + String(userId).replace(/[^A-Za-z0-9]/g, "_"); }
async function linkedName(userId){ var d = await getDoc("settings/worksUsers"); return d[userKey(userId)] || ""; }

/* ---- 日付（日本時間） ---- */
function jstToday(offsetDays){ return new Date(Date.now() + 9 * 3600 * 1000 + (offsetDays || 0) * 86400000).toISOString().slice(0, 10); }
function assigneeNames(p){ return (Array.isArray(p.assignees) ? p.assignees : []).map(function(a){ return typeof a === "string" ? a : (a && a.name) || ""; }).filter(Boolean); }
function strip(s){ return String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, ""); }
// そのメンバーが見られる案件（管理者は全件／それ以外は担当のみ）
function visibleProjects(projects, member){
  if(F.isAdminMember(member)) return projects;
  return projects.filter(function(p){ return assigneeNames(p).some(function(n){ return strip(n) === strip(member.name); }); });
}

module.exports = {configured: configured, httpErr: httpErr, sendChannel: sendChannel, sendUser: sendUser, getDoc: getDoc, listDocs: listDocs, patchDoc: patchDoc, createDoc: createDoc,
  getSettings: getSettings, userKey: userKey, linkedName: linkedName, jstToday: jstToday, assigneeNames: assigneeNames, strip: strip, visibleProjects: visibleProjects, env: env};
