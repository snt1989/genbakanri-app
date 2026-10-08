// スマホ通知（Web Push）API。POST /api/push { auth:{name,password}, action, ... }
// 必要な環境変数: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY（管理者が設定画面で生成→Vercelに登録）
// 購読情報は Firestore の settings/push に保存します（キー s_<ハッシュ> → {name, sub}）。
var crypto = require("crypto");
var F = require("./_freee");
var W = require("./_works");
var webpush = require("./_webpush");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function keyOf(endpoint){ return "s_" + crypto.createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 24); }
function configured(){ return !!(F.env("VAPID_PUBLIC_KEY") && F.env("VAPID_PRIVATE_KEY")); }
function norm(s){ return String(s || "").normalize("NFKC").replace(/[\s　]+/g, ""); }

async function recipients(chatId){
  var chat = await W.getDoc("chats/" + chatId);
  if(!chat || !chat.name && !chat.kind) return {chat: null, names: []};
  var names = [];
  if(chat.kind === "project"){
    var p = chat.projectId ? await W.getDoc("projects/" + chat.projectId) : {};
    if(!p || !p.name){
      var all = await W.listDocs("projects");
      p = all.filter(function(x){ return x.name === chat.name; })[0] || {};
    }
    names = W.assigneeNames(p);
  }else if(Array.isArray(chat.members) && chat.members.length){
    names = chat.members;
  }else{
    names = (await W.listDocs("members")).map(function(m){ return m.name; });
  }
  return {chat: chat, names: names};
}

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    var admin = F.isAdminMember(me);
    switch(b.action){
      case "status":
        return res.status(200).json({configured: configured(), publicKey: F.env("VAPID_PUBLIC_KEY") || "", admin: admin});
      case "genkeys": {
        if(!admin) return res.status(403).json({error: "管理者のみ実行できます"});
        var k = webpush.generateVAPIDKeys();
        return res.status(200).json({publicKey: k.publicKey, privateKey: k.privateKey});
      }
      case "subscribe": {
        if(!configured()) return res.status(400).json({error: "通知がまだ設定されていません（管理者が設定します）"});
        var sub = b.subscription;
        if(!sub || !sub.endpoint) return res.status(400).json({error: "購読情報がありません"});
        var d = {}; d[keyOf(sub.endpoint)] = {name: me.name, sub: JSON.stringify(sub)};
        await W.patchDoc("settings/push", d);
        return res.status(200).json({ok: true});
      }
      case "unsubscribe": {
        if(b.endpoint) await W.patchDoc("settings/push", {}, [keyOf(b.endpoint)]);
        return res.status(200).json({ok: true});
      }
      case "notify": {
        if(!configured()) return res.status(200).json({sent: 0});
        var chatId = String(b.chatId || "");
        if(!chatId) return res.status(400).json({error: "chatId"});
        var r = await recipients(chatId);
        if(!r.chat) return res.status(200).json({sent: 0});
        var want = {}; r.names.forEach(function(n){ want[norm(n)] = 1; });
        delete want[norm(me.name)];
        var doc = await W.getDoc("settings/push");
        var vapid = {publicKey: F.env("VAPID_PUBLIC_KEY"), privateKey: F.env("VAPID_PRIVATE_KEY"), subject: "mailto:" + (F.env("VAPID_SUBJECT") || "admin@example.com")};
        var text = String(b.text || "").replace(/\s+/g, " ").slice(0, 80) || "新しいメッセージ";
        var payload = JSON.stringify({title: (r.chat.name || "チャット"), body: me.name + "：" + text, chatId: chatId, tag: "chat-" + chatId});
        var sent = 0, dead = [];
        await Promise.all(Object.keys(doc).filter(function(k){ return k.indexOf("s_") === 0; }).map(async function(k){
          var e = doc[k]; if(!e || !want[norm(e.name)]) return;
          try{ await webpush.send(JSON.parse(e.sub), payload, vapid, 3600); sent++; }
          catch(err){ if(err.statusCode === 404 || err.statusCode === 410) dead.push(k); }
        }));
        if(dead.length) await W.patchDoc("settings/push", {}, dead).catch(function(){});
        return res.status(200).json({sent: sent});
      }
      default:
        return res.status(400).json({error: "unknown action"});
    }
  }catch(e){
    res.status(e.status || 500).json({error: e.message || "error"});
  }
};
