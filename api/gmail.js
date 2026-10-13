// Gmail同期API（共有Gmail1つを管理者が連携し、Gmailの「ラベル」で案件に仕分け）。
// 必要な環境変数: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET（Google Cloud のOAuthクライアント。リダイレクトURI: https://<ドメイン>/api/gmail）
//                 GMAIL_TOKEN_KEY（任意の長いランダム文字列。未設定なら FREEE_TOKEN_KEY を使用）
// 権限は gmail.readonly（読み取りのみ。Gmailの内容は変更しません）。リフレッシュトークンは AES-256-GCM で暗号化して settings/gmailAuth に保存。
// ラベル名が「案件/案件名」または「案件名」と一致するメールを、その案件の履歴(mails/<案件ID>)へ取り込みます。
var crypto = require("crypto");
var F = require("./_freee");
var W = require("./_works");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function keyStr(){ return F.env("GMAIL_TOKEN_KEY") || F.env("FREEE_TOKEN_KEY"); }
function configured(){ return !!(F.env("GOOGLE_CLIENT_ID") && F.env("GOOGLE_CLIENT_SECRET") && keyStr()); }
function key32(){ return crypto.createHash("sha256").update(keyStr()).digest(); }
function encrypt(obj){
  var iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key32(), iv);
  var enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(b64){
  var buf = Buffer.from(b64, "base64"), d = crypto.createDecipheriv("aes-256-gcm", key32(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}
function sign(s){ return crypto.createHmac("sha256", key32()).update(s).digest("hex"); }
function makeState(){ var p = crypto.randomBytes(8).toString("hex") + "." + Date.now(); return p + "." + sign(p); }
function checkState(st){
  var parts = String(st || "").split(".");
  if(parts.length !== 3) return false;
  var p = parts[0] + "." + parts[1];
  return F.safeEq(sign(p), parts[2]) && Date.now() - Number(parts[1]) < 15 * 60 * 1000;
}
function redirectUri(req){
  if(F.env("GOOGLE_REDIRECT_URI")) return F.env("GOOGLE_REDIRECT_URI");
  var host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return "https://" + host + "/api/gmail";
}
async function tokenReq(params){
  var body = new URLSearchParams(Object.assign({client_id: F.env("GOOGLE_CLIENT_ID"), client_secret: F.env("GOOGLE_CLIENT_SECRET")}, params));
  var r = await fetch("https://oauth2.googleapis.com/token", {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: body.toString()});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok || !j.access_token) throw new Error("google token: " + (j.error_description || j.error || r.status));
  return j;
}
async function loadAuth(){
  var d = await W.getDoc("settings/gmailAuth");
  if(!d || !d.enc) return null;
  try{ return decrypt(d.enc); }catch(e){ return null; }
}
async function accessToken(){
  var a = await loadAuth();
  if(!a || !a.refresh_token) throw F.httpErr(409, "Gmailと連携されていません");
  var t = await tokenReq({grant_type: "refresh_token", refresh_token: a.refresh_token});
  return {token: t.access_token, email: a.email || ""};
}
async function gapi(token, path){
  var r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {headers: {Authorization: "Bearer " + token}});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok) throw F.httpErr(502, "Gmail: " + ((j.error && (j.error.message || j.error.status)) || r.status));
  return j;
}
function norm(s){ return String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, ""); }
function labelKey(name){ return norm(String(name || "").replace(/^\s*案件\s*[\/／:：]\s*/, "")); }
function dec64(s){ return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function stripHtml(h){
  return String(h || "").replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();
}
function bodyOf(part){
  var plain = "", html = "";
  (function walk(p){
    if(!p) return;
    if(p.mimeType === "text/plain" && p.body && p.body.data && !plain) plain = dec64(p.body.data);
    else if(p.mimeType === "text/html" && p.body && p.body.data && !html) html = dec64(p.body.data);
    (p.parts || []).forEach(walk);
  })(part);
  return (plain || stripHtml(html)).trim();
}
function header(m, n){
  var h = ((m.payload || {}).headers || []).filter(function(x){ return String(x.name).toLowerCase() === n; })[0];
  return h ? String(h.value || "") : "";
}

module.exports = async function handler(req, res){
  // Googleの認可画面から戻ってくる先（GET）
  if(req.method === "GET"){
    var back = function(q){ res.statusCode = 302; res.setHeader("Location", "/?gmail=" + q); res.end(); };
    try{
      var q = req.query || {};
      if(q.error) return back("denied");
      if(!configured() || !checkState(q.state) || !q.code) return back("invalid");
      var t = await tokenReq({grant_type: "authorization_code", code: q.code, redirect_uri: redirectUri(req)});
      if(!t.refresh_token) return back("norefresh");
      var prof = await gapi(t.access_token, "profile");
      await W.patchDoc("settings/gmailAuth", {enc: encrypt({refresh_token: t.refresh_token, email: prof.emailAddress || ""}), email: prof.emailAddress || "", connectedAt: new Date().toISOString()});
      return back("ok");
    }catch(e){ console.error("gmail callback", e && e.message); return back("error"); }
  }
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "GET, POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    var admin = F.isAdminMember(me);
    if(me.permission === "external") return res.status(403).json({error: "この権限ではGmail同期を使えません"});
    if(b.action === "status"){
      var cur = configured() ? await W.getDoc("settings/gmailAuth") : {};
      return res.status(200).json({configured: configured(), connected: !!(cur && cur.enc), email: (cur && cur.email) || "", connectedAt: (cur && cur.connectedAt) || "", lastSync: (cur && cur.lastSync) || "", admin: admin});
    }
    if(b.action === "authurl"){
      if(!admin) return res.status(403).json({error: "管理者のみ実行できます"});
      if(!configured()) return res.status(200).json({error: "notconfigured"});
      var u = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({client_id: F.env("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri(req), response_type: "code",
        scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", prompt: "consent", state: makeState()}).toString();
      return res.status(200).json({url: u});
    }
    if(b.action === "disconnect"){
      if(!admin) return res.status(403).json({error: "管理者のみ実行できます"});
      await F.fsDelete("settings/gmailAuth");
      return res.status(200).json({ok: true});
    }
    if(b.action === "sync"){
      if(!configured()) return res.status(200).json({error: "notconfigured"});
      var at = await accessToken();
      var projects = W.visibleProjects(await W.listDocs("projects"), me).filter(function(p){ return p && p.name; });
      var byKey = {}; projects.forEach(function(p){ byKey[norm(p.name)] = p; });
      var only = b.projectId ? String(b.projectId) : "";
      var labels = (await gapi(at.token, "labels")).labels || [];
      var matched = labels.filter(function(l){ return l.type === "user" && byKey[labelKey(l.name)] && (!only || byKey[labelKey(l.name)].id === only); });
      var added = 0, left = 0, LIMIT = 30, results = {};
      for(var i = 0; i < matched.length; i++){
        var l = matched[i], p = byKey[labelKey(l.name)];
        var ids = ((await gapi(at.token, "messages?maxResults=50&labelIds=" + encodeURIComponent(l.id))).messages || []).map(function(m){ return m.id; });
        if(!ids.length) continue;
        var doc = await W.getDoc("mails/" + p.id);
        var fresh = ids.filter(function(id){ return !doc["m_g" + id]; });
        var take = fresh.slice(0, Math.max(0, LIMIT - added)); left += fresh.length - take.length;
        var o = {};
        for(var j = 0; j < take.length; j++){
          var m = await gapi(at.token, "messages/" + take[j] + "?format=full");
          var from = header(m, "from");
          var out = !!at.email && from.toLowerCase().indexOf(at.email.toLowerCase()) !== -1;
          o["m_g" + take[j]] = {dir: out ? "out" : "in", from: from.slice(0, 200), to: header(m, "to").slice(0, 300), cc: header(m, "cc").slice(0, 300), subject: header(m, "subject").slice(0, 300),
            body: bodyOf(m.payload).slice(0, 8000), at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(), by: "Gmail"};
        }
        if(Object.keys(o).length){ await W.patchDoc("mails/" + p.id, o); added += Object.keys(o).length; results[p.name] = Object.keys(o).length; }
      }
      await W.patchDoc("settings/gmailAuth", {lastSync: new Date().toISOString()}).catch(function(){});
      return res.status(200).json({ok: true, added: added, left: left, labels: matched.length, results: results});
    }
    return res.status(400).json({error: "不明な操作です"});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
};
