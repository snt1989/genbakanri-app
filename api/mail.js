// 案件メール API。POST /api/mail { auth:{name,password}, action, ... }
// 必要な環境変数: RESEND_API_KEY（Resendのキー） / MAIL_FROM（例: 株式会社三桜 <info@example.co.jp>。Resendで認証済みのドメイン）
// 履歴は Firestore の mails/<案件ID> に1文書で保存（キー m_<時刻> → {dir,from,to,cc,subject,body,at,by}）。履歴を読むときだけ1回読み取ります。
var F = require("./_freee");
var W = require("./_works");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function configured(){ return !!(F.env("RESEND_API_KEY") && F.env("MAIL_FROM")); }
function emails(v){
  return String(v || "").split(/[,、;；\s]+/).map(function(s){ return s.trim(); }).filter(function(s){ return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s); }).slice(0, 20);
}
function clean(s, n){ return String(s == null ? "" : s).slice(0, n); }
function list(doc){
  return Object.keys(doc).filter(function(k){ return k.indexOf("m_") === 0 && doc[k] && typeof doc[k] === "object"; })
    .map(function(k){ var m = doc[k]; m.key = k; return m; })
    .sort(function(a, b){ return String(b.at || "").localeCompare(String(a.at || "")); });
}
function newKey(){ return "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    if(me.permission === "external") return res.status(403).json({error: "この権限ではメール機能を使えません"});
    if(b.action === "status") return res.status(200).json({configured: configured(), from: F.env("MAIL_FROM") || ""});

    var pid = clean(b.projectId, 80);
    if(!pid) return res.status(400).json({error: "案件が指定されていません"});
    var proj = await W.getDoc("projects/" + pid);
    if(!proj || !proj.name) return res.status(404).json({error: "案件が見つかりません"});
    if(!W.visibleProjects([proj], me).length) return res.status(403).json({error: "この案件のメールは担当者・管理者のみ扱えます"});
    var path = "mails/" + pid;

    if(b.action === "list"){
      return res.status(200).json({mails: list(await W.getDoc(path))});
    }
    var now = new Date().toISOString();
    if(b.action === "record"){   // 受信・やり取りの記録（手入力）
      var rec = {dir: "in", from: clean(b.from, 200), to: clean(b.to, 200), cc: "", subject: clean(b.subject, 300), body: clean(b.body, 20000), at: b.at ? clean(b.at, 40) : now, by: me.name};
      if(!rec.from && !rec.subject && !rec.body) return res.status(400).json({error: "内容が空です"});
      var o = {}; o[newKey()] = rec; await W.patchDoc(path, o);
      return res.status(200).json({ok: true});
    }
    if(b.action === "remove"){
      if(!F.isAdminMember(me)) return res.status(403).json({error: "削除は管理者のみ"});
      var k = clean(b.key, 40); if(k.indexOf("m_") !== 0) return res.status(400).json({error: "不正なキー"});
      await W.patchDoc(path, {}, [k]);
      return res.status(200).json({ok: true});
    }
    if(b.action === "send"){
      if(!configured()) return res.status(200).json({error: "notconfigured"});
      var to = emails(b.to), cc = emails(b.cc);
      if(!to.length) return res.status(400).json({error: "宛先のメールアドレスが正しくありません"});
      var subject = clean(b.subject, 300).trim(), body = clean(b.body, 20000);
      if(!subject || !body.trim()) return res.status(400).json({error: "件名と本文を入力してください"});
      var payload = {from: F.env("MAIL_FROM"), to: to, subject: subject, text: body};
      if(cc.length) payload.cc = cc;
      var rt = emails(me.email); if(rt.length) payload.reply_to = rt[0];
      var r = await fetch("https://api.resend.com/emails", {method: "POST", headers: {"Authorization": "Bearer " + F.env("RESEND_API_KEY"), "Content-Type": "application/json"}, body: JSON.stringify(payload)});
      var j = await r.json().catch(function(){ return {}; });
      if(!r.ok) return res.status(200).json({error: "send", detail: clean(j.message || j.name || ("HTTP " + r.status), 300)});
      var o2 = {}; o2[newKey()] = {dir: "out", from: F.env("MAIL_FROM"), to: to.join(", "), cc: cc.join(", "), subject: subject, body: body, at: now, by: me.name};
      await W.patchDoc(path, o2).catch(function(){});
      return res.status(200).json({ok: true});
    }
    return res.status(400).json({error: "不明な操作です"});
  }catch(e){
    return res.status(e.status || 500).json({error: "server", detail: String(e.message || e).slice(0, 200)});
  }
};
