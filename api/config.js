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
var W = require("./_works");

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


// ---- Firestoreの実使用量(Cloud Monitoring)。POST /api/config {action:"usage", auth:{...}} 管理者のみ ----
// 必要: GCP_SERVICE_ACCOUNT（サービスアカウントのJSONキー全文。権限「モニタリング閲覧者」）をVercel環境変数に登録
var gTok = {t: "", exp: 0};
function gSA(){
  var raw = F.env("GCP_SERVICE_ACCOUNT"); if(!raw) return null;
  try{ if(raw.charAt(0) !== "{") raw = Buffer.from(raw, "base64").toString("utf8"); var j = JSON.parse(raw); if(j.client_email && j.private_key) return j; }catch(e){}
  return null;
}
async function gToken(sa){
  if(gTok.t && Date.now() < gTok.exp) return gTok.t;
  var now = Math.floor(Date.now()/1000);
  var head = b64u(JSON.stringify({alg:"RS256", typ:"JWT"}));
  var claim = b64u(JSON.stringify({iss: sa.client_email, scope: "https://www.googleapis.com/auth/monitoring.read", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600}));
  var sig = b64u(crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(sa.private_key));
  var r = await fetch("https://oauth2.googleapis.com/token", {method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + claim + "." + sig});
  var j = await r.json();
  if(!j.access_token) throw new Error("Googleの認証に失敗: " + (j.error_description || j.error || r.status));
  gTok = {t: j.access_token, exp: Date.now() + 3000000};
  return gTok.t;
}
async function gMetric(token, project, type, startMs, endMs){
  var q = "filter=" + encodeURIComponent('metric.type="firestore.googleapis.com/document/' + type + '"') +
    "&interval.startTime=" + encodeURIComponent(new Date(startMs).toISOString()) + "&interval.endTime=" + encodeURIComponent(new Date(endMs).toISOString()) +
    "&aggregation.alignmentPeriod=3600s&aggregation.perSeriesAligner=ALIGN_SUM&aggregation.crossSeriesReducer=REDUCE_SUM&view=FULL";
  var r = await fetch("https://monitoring.googleapis.com/v3/projects/" + encodeURIComponent(project) + "/timeSeries?" + q, {headers:{Authorization: "Bearer " + token}});
  var j = await r.json();
  if(!r.ok) throw new Error((j.error && j.error.message) || ("Monitoring API " + r.status));
  var total = 0, hours = {};
  (j.timeSeries || []).forEach(function(ts){ (ts.points || []).forEach(function(p){
    var v = Number((p.value && (p.value.int64Value != null ? p.value.int64Value : p.value.doubleValue)) || 0);
    total += v; var k = p.interval && p.interval.endTime; if(k) hours[k] = (hours[k] || 0) + v;
  }); });
  return {total: total, hours: hours};
}
// 無料枠の1日は太平洋時間の0時区切り
function pacificDayStart(nowMs){
  var f = new Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles", hour12:false, hour:"2-digit", minute:"2-digit", second:"2-digit"});
  var p = {}; f.formatToParts(new Date(nowMs)).forEach(function(x){ p[x.type] = x.value; });
  var sec = (Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second);
  return nowMs - sec * 1000;
}
async function usageHandler(req, res, b){
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me || !F.isAdminMember(me)) return res.status(403).json({error: "管理者のみ利用できます"});
    var sa = gSA(), project = F.env("FIREBASE_PROJECT_ID");
    if(!sa || !project) return res.status(200).json({error: "notconfigured"});
    var now = Date.now(), start = pacificDayStart(now);
    var tok = await gToken(sa);
    var rs = await Promise.all([gMetric(tok, project, "read_count", start, now), gMetric(tok, project, "write_count", start, now), gMetric(tok, project, "delete_count", start, now)]);
    return res.status(200).json({ok: true, at: now, dayStart: start, dayEnd: start + 86400000,
      reads: rs[0].total, writes: rs[1].total, deletes: rs[2].total,
      limits: {reads: 50000, writes: 20000, deletes: 20000}, readHours: rs[0].hours});
  }catch(e){
    return res.status(200).json({error: "server", detail: String(e.message || e).slice(0, 300)});
  }
}

// ---- 報告写真アプリ → 案件へPDFを保存 ----
// 1) 現場管理が「報告書を作成」で案件つきの署名付きチケット(12時間)を発行し、報告写真アプリを開く
// 2) 報告写真アプリがPDFを約600KBずつ送り(report-chunk)、最後に report-finish で案件の「写真・ファイル」に登録
// 環境変数: SSO_SECRET（共通）／任意: REPORT_URL（既定 https://houkokusho-two.vercel.app）
function reportOrigin(){ return (F.env("REPORT_URL") || "https://houkokusho-two.vercel.app").replace(/\/+$/, ""); }
function setCors(res){
  res.setHeader("Access-Control-Allow-Origin", reportOrigin());
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}
function readTicket(t, secret){
  try{
    var parts = String(t || "").split(".");
    if(parts.length !== 2) return null;
    var want = b64u(crypto.createHmac("sha256", secret).update(parts[0]).digest());
    var a = Buffer.from(parts[1]), b = Buffer.from(want);
    if(a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    var p = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if(!p || p.k !== "r" || !p.exp || Date.now() > p.exp) return null;
    return p;
  }catch(e){ return null; }
}
function makeReportTicket(me, project, secret){
  var payload = b64u(JSON.stringify({k: "r", n: me.name, p: project.id, pn: project.name || "", c: project.customerName || "", ad: project.address || "", exp: Date.now() + 12 * 3600000, j: crypto.randomBytes(6).toString("hex")}));
  return payload + "." + b64u(crypto.createHmac("sha256", secret).update(payload).digest());
}
async function reportHandler(req, res, b){
  setCors(res);
  try{
    var secret = F.env("SSO_SECRET");
    if(!secret || secret.length < 16) return res.status(200).json({error: "notconfigured"});
    if(b.action === "report-ticket"){
      var a = b.auth || {};
      var me = await F.verifyMember(a.name, a.password);
      if(!me) return res.status(403).json({error: "認証に失敗しました"});
      var p = await W.getDoc("projects/" + encodeURIComponent(String(b.projectId || "")));
      if(!p || !p.id || !W.visibleProjects([p], me).length) return res.status(403).json({error: "この案件は利用できません"});
      return res.status(200).json({url: reportOrigin() + "/?gk=" + makeReportTicket(me, p, secret)});
    }
    // 以下は報告写真アプリからの呼び出し（チケットが認証）
    var t = readTicket(b.ticket, secret);
    if(!t) return res.status(403).json({error: "チケットの有効期限が切れました。現場管理アプリの案件から開き直してください"});
    var up = String(b.uploadId || "");
    if(!/^[A-Za-z0-9]{10,40}$/.test(up)) return res.status(400).json({error: "bad uploadId"});
    var total = Number(b.total);
    if(!(total >= 1 && total <= 40 && Number.isInteger(total))) return res.status(400).json({error: "ファイルが大きすぎます（上限 約20MB）"});
    if(b.action === "report-chunk"){
      var i = Number(b.i), d = String(b.data || "");
      if(!(Number.isInteger(i) && i >= 0 && i < total)) return res.status(400).json({error: "bad index"});
      if(!d || d.length > 900000 || !/^[A-Za-z0-9+\/=]+$/.test(d)) return res.status(400).json({error: "bad data"});
      await W.patchDoc("fileChunks/" + up + "_" + i, {fileId: up, i: i, data: d});
      return res.status(200).json({ok: true});
    }
    if(b.action === "report-finish"){
      var exist = await W.getDoc("files/" + up);
      if(exist && exist.id && exist.projectId !== t.p) return res.status(403).json({error: "このファイルは上書きできません"});
      var last = await W.getDoc("fileChunks/" + up + "_" + (total - 1));
      if(!last || !last.data) return res.status(400).json({error: "最後のデータが届いていません。もう一度お試しください"});
      var fn = String(b.filename || "報告書.pdf").replace(/[\\/:*?"<>|]/g, "").slice(0, 120) || "報告書.pdf";
      await W.patchDoc("files/" + up, {projectId: t.p, projectName: t.pn || "", folderId: null, assetId: null, url: null, chunked: true, chunks: total,
        filename: fn, contentType: "application/pdf", size: Math.max(0, Number(b.size) || 0), uploadedAt: new Date().toISOString(), uploadedBy: t.n, source: "報告写真アプリ"});
      return res.status(200).json({ok: true, id: up});
    }
    return res.status(400).json({error: "unknown action"});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
}

async function ssoHandler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  if(b.action === "usage") return usageHandler(req, res, b);
  if(String(b.action || "").indexOf("report-") === 0) return reportHandler(req, res, b);
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
  if(req.method === "OPTIONS"){ setCors(res); res.statusCode = 204; return res.end(); }
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
