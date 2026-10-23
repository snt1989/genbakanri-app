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
function makeTicket(name, secret, project, kind){
  var o = {n: name, exp: Date.now() + 60000, j: crypto.randomBytes(6).toString("hex")};
  if(kind) o.k = kind;   // 発行先の種類（"s" = 社用車管理）。受け取る側が、他のアプリ向けのチケットを使い回されないように確認する
  if(project && project.id){ o.p = String(project.id); o.pn = String(project.name || "").slice(0, 80); if(project.division) o.dv = String(project.division).slice(0, 60); }   // 案件を指定して備品管理アプリを開く（現場名の紐づけ用）
  var payload = b64u(JSON.stringify(o));
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
  project = project || {};
  var payload = b64u(JSON.stringify({k: "r", n: me.name, a: F.isAdminMember(me) ? 1 : 0, p: project.id || "", pn: project.name || "", c: project.customerName || "", ad: project.address || "", exp: Date.now() + 12 * 3600000, j: crypto.randomBytes(6).toString("hex")}));
  return payload + "." + b64u(crypto.createHmac("sha256", secret).update(payload).digest());
}
// 報告写真アプリの「案件を選ぶ」用：読み取り量を抑えるため、清算済・失注を除く案件だけを取得し、90秒キャッシュする
var __activeCache = {at: 0, list: []};
async function activeProjects(){
  if(Date.now() - __activeCache.at < 90000 && __activeCache.list.length) return __activeCache.list;
  var body = {structuredQuery: {from: [{collectionId: "projects"}], where: {fieldFilter: {field: {fieldPath: "status"}, op: "NOT_IN", value: {arrayValue: {values: [{stringValue: "清算済"}, {stringValue: "失注"}]}}}}, limit: 1500}};
  var r = await fetch(W.fsBase() + ":runQuery?" + W.keyQ(), {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  if(!r.ok) throw W.httpErr(502, r.status === 429 ? "Firestoreの無料枠（1日の読み取り上限）を超えています" : "firestore " + r.status);
  var j = await r.json();
  var list = (Array.isArray(j) ? j : []).filter(function(x){ return x && x.document; }).map(function(x){ return W.decDoc(x.document); });
  __activeCache = {at: Date.now(), list: list};
  return list;
}
function projectBrief(p){ return {id: p.id, name: p.name || "", customer: p.customerName || "", address: p.address || "", status: p.status || ""}; }
async function reportHandler(req, res, b){
  setCors(res);
  try{
    var secret = F.env("SSO_SECRET");
    if(!secret || secret.length < 16) return res.status(200).json({error: "notconfigured"});
    if(b.action === "report-ticket"){
      var a = b.auth || {};
      var me = await F.verifyMember(a.name, a.password);
      if(!me) return res.status(403).json({error: "認証に失敗しました"});
      if(!b.projectId) return res.status(200).json({url: reportOrigin() + "/?gk=" + makeReportTicket(me, null, secret)});   // 案件を決めずに開く（アプリの中で案件を選ぶ）
      var p = await W.getDoc("projects/" + encodeURIComponent(String(b.projectId || "")));
      if(!p || !p.id || !W.visibleProjects([p], me).length) return res.status(403).json({error: "この案件は利用できません"});
      return res.status(200).json({url: reportOrigin() + "/?gk=" + makeReportTicket(me, p, secret)});
    }
    // 報告写真アプリの中で案件を選ぶ（チケットで認証。見られる案件だけ返す）
    if(b.action === "report-projects" || b.action === "report-switch"){
      var tk = readTicket(b.ticket, secret);
      if(!tk) return res.status(403).json({error: "チケットの有効期限が切れました。現場管理アプリの案件から開き直してください"});
      var who = {name: tk.n, permission: tk.a ? "admin" : "member"};
      if(b.action === "report-projects"){
        var q = W.strip(b.q || "");
        var vis = W.visibleProjects(await activeProjects(), who);
        if(q) vis = vis.filter(function(p){ return W.strip([p.name, p.customerName, p.address].join(" ")).indexOf(q) !== -1; });
        vis.sort(function(x, y){ return String(y.updatedAt || y.createdAt || "").localeCompare(String(x.updatedAt || x.createdAt || "")); });
        return res.status(200).json({projects: vis.slice(0, 60).map(projectBrief), total: vis.length});
      }
      var sp = await W.getDoc("projects/" + encodeURIComponent(String(b.projectId || "")));
      if(!sp || !sp.id || !W.visibleProjects([sp], who).length) return res.status(403).json({error: "この案件は利用できません"});
      return res.status(200).json({ticket: makeReportTicket(who, sp, secret), project: projectBrief(sp)});
    }
    // 以下は報告写真アプリからの呼び出し（チケットが認証）
    var t = readTicket(b.ticket, secret);
    if(!t) return res.status(403).json({error: "チケットの有効期限が切れました。現場管理アプリの案件から開き直してください"});
    if(b.action === "report-verify") return res.status(200).json({ok: true, name: t.n});   // 報告写真アプリが、案件から開かれたこと（ログイン済みであること）を確認する
    if(!t.p) return res.status(400).json({error: "案件が選ばれていません。報告写真アプリで案件を選んでください"});
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

// ---- Instagram投稿文のAI作成。環境変数 ANTHROPIC_API_KEY（任意: ANTHROPIC_MODEL）があるときだけ有効。キーが無ければ enabled:false を返し、アプリは定型文だけを使う ----
async function snsAiHandler(req, res, b){
  try{
    var key = F.env("ANTHROPIC_API_KEY");
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    if(!key) return res.status(200).json({enabled: false});
    if(b.probe) return res.status(200).json({enabled: true});
    var f = b.facts || {};
    var cut = function(x, n){ return String(x == null ? "" : x).slice(0, n); };
    var facts = [
      "工事の種類: " + cut(f.type, 60),
      "事業部: " + cut(f.division, 40),
      "場所: " + cut(f.place, 60),
      "施工日: " + cut(f.period, 60),
      "現場でのひとこと: " + cut(f.memo, 400),
      "会社名: " + cut(f.company, 60),
      "ハッシュタグの候補: " + cut(f.tags, 300)
    ].join("\n") + (f.material ? "\n\n案件から抜き出した情報（具体的な作業内容・工程・現場の様子・気づきなど）:\n" + cut(f.material, 3500) : "");
    var prompt = "あなたは建設・造園・除雪会社の広報担当です。次の施工情報をもとに、Instagramの投稿文を日本語で1つ作ってください。\n" +
      "条件:\n- 親しみやすく丁寧な文体。全体で300〜500字程度。\n- 「案件から抜き出した情報」がある場合は、そこにある具体的な作業内容・手順・工夫・現場の様子・仕上がりを、事実のとおりに本文へ盛り込む（数字や固有の作業名を使い、ありきたりな言い回しだけにしない）。情報に無いことは作らない。絵文字は多くても4個。\n- 下の「施工内容・経過」から、作業の内容・工夫した点・仕上がり・苦労した点など具体的な事実を拾って書く（数字や固有の作業名を活かす）。\n- お客様の名前・個人名・詳しい住所・金額は書かない。下の情報に無いことは、推測して書かない。\n- 最後に問い合わせを促す一文と、ハッシュタグ（候補を使い、最大10個）を付ける。\n- 投稿文の本文だけを出力し、前置きや説明は書かない。\n" +
      (f.style ? "- 文体の指定: " + cut(f.style, 40) + "\n" : "") +
      "\n施工情報:\n" + facts;
    var model = F.env("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
    var r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"},
      body: JSON.stringify({model: model, max_tokens: 1000, messages: [{role: "user", content: prompt}]})
    });
    var j = await r.json().catch(function(){ return {}; });
    if(!r.ok) return res.status(200).json({error: "ai", detail: cut((j.error && j.error.message) || ("status " + r.status), 160)});
    var text = (j.content || []).filter(function(c){ return c.type === "text"; }).map(function(c){ return c.text; }).join("").trim();
    if(!text) return res.status(200).json({error: "ai", detail: "empty"});
    return res.status(200).json({enabled: true, text: text});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
}

// ---- Instagramへの直接投稿（Instagram Graph API）。環境変数 IG_USER_ID と IG_ACCESS_TOKEN があるときだけ有効。管理者のみ ----
function igSecret(){ return crypto.createHash("sha256").update("igimg:" + F.env("IG_ACCESS_TOKEN")).digest(); }
function igSig(id, exp){ return crypto.createHmac("sha256", igSecret()).update(id + "." + exp).digest("hex").slice(0, 32); }
function igEnabled(){ return !!(F.env("IG_USER_ID") && F.env("IG_ACCESS_TOKEN")); }
async function igImageHandler(req, res){
  var q = req.query || {}, id = String(q.igimg || ""), exp = String(q.exp || ""), sig = String(q.sig || "");
  if(!igEnabled() || !/^[A-Za-z0-9_-]{4,64}$/.test(id) || !(Number(exp) > Date.now()) || sig !== igSig(id, exp)) return res.status(403).end("forbidden");
  var d = await W.getDoc("files/" + id);
  var m = String(d && d.url || "").match(/^data:(image\/jpeg);base64,(.+)$/s);
  if(!m) return res.status(404).end("not found");
  res.setHeader("Content-Type", "image/jpeg"); res.setHeader("Cache-Control", "no-store");
  return res.status(200).end(Buffer.from(m[2], "base64"));
}
async function igGraph(path, method, params){
  var base = "https://graph.facebook.com/" + (F.env("IG_API_VERSION") || "v21.0") + "/" + path;
  var p = new URLSearchParams(Object.assign({access_token: F.env("IG_ACCESS_TOKEN")}, params || {}));
  var r = method === "GET" ? await fetch(base + "?" + p.toString()) : await fetch(base, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: p.toString()});
  var j = await r.json().catch(function(){ return {}; });
  if(!r.ok || j.error){ var e = new Error((j.error && j.error.message) || ("instagram " + r.status)); e.status = 502; throw e; }
  return j;
}
async function igWait(id){
  for(var i = 0; i < 12; i++){
    var j = await igGraph(id, "GET", {fields: "status_code"});
    if(j.status_code === "FINISHED" || !j.status_code) return;
    if(j.status_code === "ERROR" || j.status_code === "EXPIRED") throw Object.assign(new Error("Instagram側で画像を処理できませんでした（JPEG画像のみ投稿できます）"), {status: 502});
    await new Promise(function(r){ setTimeout(r, 1000); });
  }
}
async function igHandler(req, res, b){
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    if(!F.isAdminMember(me)) return res.status(200).json({enabled: false, reason: "admin"});
    if(!igEnabled()) return res.status(200).json({enabled: false});
    if(b.probe) return res.status(200).json({enabled: true});
    var ids = (Array.isArray(b.fileIds) ? b.fileIds : []).map(String).slice(0, 10);
    var caption = String(b.caption || "").slice(0, 2200);
    if(!ids.length) return res.status(400).json({error: "写真を1枚以上選んでください"});
    if(!caption.trim()) return res.status(400).json({error: "投稿文が空です"});
    var pd = await W.getDoc("projects/" + encodeURIComponent(String(b.projectId || "")));
    if(!pd || !pd.id || !W.visibleProjects([pd], me).length) return res.status(403).json({error: "この案件は利用できません"});
    var host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
    if(!host) return res.status(500).json({error: "host"});
    var exp = String(Date.now() + 30 * 60000), urls = [];
    for(var i = 0; i < ids.length; i++){
      if(!/^[A-Za-z0-9_-]{4,64}$/.test(ids[i])) return res.status(400).json({error: "写真の指定が正しくありません"});
      var fd = await W.getDoc("files/" + ids[i]);
      if(!fd || fd.projectId !== pd.id || !/^data:image\/jpeg;base64,/.test(String(fd.url || ""))) return res.status(400).json({error: "JPEG形式のこの案件の写真だけ投稿できます"});
      urls.push("https://" + host + "/api/config?igimg=" + ids[i] + "&exp=" + exp + "&sig=" + igSig(ids[i], exp));
    }
    var uid = F.env("IG_USER_ID"), creation;
    if(urls.length === 1){
      creation = (await igGraph(uid + "/media", "POST", {image_url: urls[0], caption: caption})).id;
    }else{
      var kids = [];
      for(var k = 0; k < urls.length; k++){ var c = await igGraph(uid + "/media", "POST", {image_url: urls[k], is_carousel_item: "true"}); await igWait(c.id); kids.push(c.id); }
      creation = (await igGraph(uid + "/media", "POST", {media_type: "CAROUSEL", children: kids.join(","), caption: caption})).id;
    }
    await igWait(creation);
    var pub = await igGraph(uid + "/media_publish", "POST", {creation_id: creation});
    var link = "";
    try{ link = (await igGraph(pub.id, "GET", {fields: "permalink"})).permalink || ""; }catch(e){}
    return res.status(200).json({enabled: true, ok: true, permalink: link});
  }catch(e){
    return res.status(200).json({error: "ig", detail: String(e.message || e).slice(0, 220)});
  }
}

async function ssoHandler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  if(b.action === "usage") return usageHandler(req, res, b);
  if(String(b.action || "").indexOf("report-") === 0) return reportHandler(req, res, b);
  if(b.action === "sns-ai") return snsAiHandler(req, res, b);
  if(b.action === "sns-ig") return igHandler(req, res, b);
  try{
    var secret = F.env("SSO_SECRET");
    if(!secret || secret.length < 16) return res.status(200).json({error: "notconfigured"});
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    var toShayosha = b.app === "shayosha";   // 社用車管理アプリへ（ログイン引き継ぎ＋行先に現場名）
    var base = toShayosha ? (F.env("SHAYOSHA_URL") || "https://shayosha-kanri.vercel.app").replace(/\/+$/, "") : (F.env("BIHIN_URL") || "https://bihinkanriapp.vercel.app").replace(/\/+$/, "");
    var proj = null;
    if(b.projectId){
      var pd = await W.getDoc("projects/" + encodeURIComponent(String(b.projectId)));
      if(!pd || !pd.id || !W.visibleProjects([pd], me).length) return res.status(403).json({error: "この案件は利用できません"});
      proj = pd;
    }
    return res.status(200).json({url: base + "/?sso=" + makeTicket(me.name, secret, proj, toShayosha ? "s" : "")});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
}

// ---- 予約投稿の定期実行（Vercel Cron が GET /api/config?snscron=1 を呼ぶ。vercel.json）----
// 管理者がアプリを開いている間は画面側が時刻どおりに投稿する。閉じている間の分を、ここで拾って投稿する。
// 画面側が先に処理できるよう、予約時刻から10分以上たった投稿だけを対象にする。
async function igPublishScheduled(host, pd, ids, caption){
  var exp = String(Date.now() + 30 * 60000), urls = [];
  for(var i = 0; i < ids.length; i++){
    if(!/^[A-Za-z0-9_-]{4,64}$/.test(ids[i])) throw new Error("写真の指定が正しくありません");
    var fd = await W.getDoc("files/" + ids[i]);
    if(!fd || fd.projectId !== pd.id || !/^data:image\/jpeg;base64,/.test(String(fd.url || ""))) throw new Error("JPEG形式のこの案件の写真だけ投稿できます");
    urls.push("https://" + host + "/api/config?igimg=" + ids[i] + "&exp=" + exp + "&sig=" + igSig(ids[i], exp));
  }
  var uid = F.env("IG_USER_ID"), creation;
  if(urls.length === 1){
    creation = (await igGraph(uid + "/media", "POST", {image_url: urls[0], caption: caption})).id;
  }else{
    var kids = [];
    for(var k = 0; k < urls.length; k++){ var c = await igGraph(uid + "/media", "POST", {image_url: urls[k], is_carousel_item: "true"}); await igWait(c.id); kids.push(c.id); }
    creation = (await igGraph(uid + "/media", "POST", {media_type: "CAROUSEL", children: kids.join(","), caption: caption})).id;
  }
  await igWait(creation);
  var pub = await igGraph(uid + "/media_publish", "POST", {creation_id: creation});
  var link = "";
  try{ link = (await igGraph(pub.id, "GET", {fields: "permalink"})).permalink || ""; }catch(e){}
  return link;
}
async function snsCronHandler(req, res){
  res.setHeader("Cache-Control", "no-store");
  var secret = F.env("CRON_SECRET");
  if(!secret) return res.status(503).json({error: "CRON_SECRET が未設定です"});
  if(!F.safeEq(req.headers.authorization || "", "Bearer " + secret)) return res.status(401).json({error: "unauthorized"});
  try{
    if(!igEnabled()) return res.status(200).json({skipped: "instagram not configured"});
    var host = F.env("APP_HOST") || F.env("VERCEL_PROJECT_PRODUCTION_URL") || String(req.headers["x-forwarded-host"] || req.headers.host || "");
    if(!host) return res.status(200).json({skipped: "host"});
    var t0 = Date.now(), now = Date.now(), iso = function(){ return new Date().toISOString(); };
    var docs = await W.listDocs("snsPosts"), posted = 0, failed = 0;
    // 投稿中のまま15分以上たったもの：結果が分からないので、二重投稿を避けて「要確認」にする
    var stuck = docs.filter(function(x){ return x.status === "posting" && now - Date.parse(x.updatedAt || 0) > 15 * 60000; });
    for(var s = 0; s < stuck.length; s++){
      await W.patchDoc("snsPosts/" + stuck[s].id, {status: "failed", error: "投稿の結果が確認できませんでした。Instagramで確認してから再投稿してください", updatedAt: iso()});
    }
    var due = docs.filter(function(x){ return x.status === "scheduled" && x.scheduledAt && Date.parse(x.scheduledAt) <= now - 10 * 60000; })
      .sort(function(a, b){ return String(a.scheduledAt).localeCompare(String(b.scheduledAt)); });
    for(var i = 0; i < due.length && i < 3; i++){
      if(Date.now() - t0 > 12000) break;   // 実行時間の上限（30秒）に余裕を持たせる。残りは次回
      var x = due[i];
      await W.patchDoc("snsPosts/" + x.id, {status: "posting", error: "", updatedAt: iso()});
      try{
        var ids = (Array.isArray(x.fileIds) ? x.fileIds : []).map(String).slice(0, 10);
        var caption = String(x.caption || "").slice(0, 2200);
        if(!ids.length || !caption.trim()) throw new Error("写真または投稿文がありません");
        var pd = await W.getDoc("projects/" + encodeURIComponent(String(x.projectId || "")));
        if(!pd || !pd.id) throw new Error("案件が見つかりません");
        var link = await igPublishScheduled(host, pd, ids, caption);
        await W.patchDoc("snsPosts/" + x.id, {status: "posted", postedAt: iso(), permalink: link, error: "", updatedAt: iso()});
        posted++;
      }catch(e){
        failed++;
        await W.patchDoc("snsPosts/" + x.id, {status: "failed", error: String(e.message || e).slice(0, 300), updatedAt: iso()}).catch(function(){});
      }
    }
    return res.status(200).json({posted: posted, failed: failed, waiting: Math.max(0, due.length - posted - failed)});
  }catch(e){
    console.error("sns cron", e.message);
    return res.status(500).json({error: e.message});
  }
}

module.exports = async function handler(req, res) {
  if(req.method === "OPTIONS"){ setCors(res); res.statusCode = 204; return res.end(); }
  if(req.method === "POST") return ssoHandler(req, res);
  if(req.method === "GET" && req.query && req.query.snscron) return snsCronHandler(req, res);
  if(req.method === "GET" && req.query && req.query.igimg){ try{ return await igImageHandler(req, res); }catch(e){ return res.status(500).end("error"); } }

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
