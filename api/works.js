// LINE WORKS 連携API。POST /api/works  { auth:{name,password}, action, ... }
// すべての操作で、メンバーの氏名＋パスワードをサーバー側で照合します。設定の変更・テスト送信は管理者のみ。
var F = require("./_freee");
var W = require("./_works");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
var FLAGS = ["notifyStatus", "notifyReport", "notifyTask", "notifyDigest"];
var EVENT_FLAG = {status: "notifyStatus", report: "notifyReport", task: "notifyTask"};

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    if(!W.configured()) return res.status(200).json({configured: false});
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    res.status(200).json(await run(b, me, req));
  }catch(e){
    res.status(e.status || 500).json({error: e.message || "error"});
  }
};

function host(req){ return (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim(); }
function need(cond, msg){ if(!cond) throw W.httpErr(403, msg); }
function who(me){ return String(me.name || "").replace(/[\s　]+/g, " "); }

async function run(b, me, req){
  var admin = F.isAdminMember(me);
  var s = await W.getSettings();
  switch(b.action){
    case "status": {
      var users = await W.getDoc("settings/worksUsers");
      var linked = Object.keys(users).filter(function(k){ return k.indexOf("u_") === 0; }).map(function(k){ return users[k]; });
      var out = {configured: true, myLinked: linked.indexOf(me.name) !== -1};
      if(admin){
        out.channelId = s.channelId || "";
        out.flags = {}; FLAGS.forEach(function(f){ out.flags[f] = s[f] !== false; });
        out.botSecretSet = !!W.env("WORKS_BOT_SECRET");
        out.cronSecretSet = !!W.env("CRON_SECRET");
        out.callbackUrl = "https://" + host(req) + "/api/works-callback";
        out.linked = linked;
        var dbg = await W.getDoc("settings/worksDebug");
        out.debug = dbg.at ? {at: dbg.at, msg: dbg.msg || ""} : null;
      }
      return out;
    }
    case "directory": {
      need(admin, "管理者のみ実行できます");
      return {users: await W.listUsers()};
    }
    case "saveSettings": {
      need(admin, "管理者のみ変更できます");
      var d = {};
      if(typeof b.channelId === "string") d.channelId = b.channelId.trim();
      FLAGS.forEach(function(f){ if(typeof b[f] === "boolean") d[f] = b[f]; });
      await W.patchDoc("settings/works", d);
      return {ok: true};
    }
    case "test": {
      need(admin, "管理者のみ実行できます");
      if(!s.channelId) throw W.httpErr(400, "送り先のトークルームが未設定です（Botをトークルームに追加するか、チャンネルIDを入力してください）");
      await W.sendChannel(s.channelId, "【現場管理アプリ】テスト送信です。この通知が届いていれば連携は正常です。（送信者: " + who(me) + "）");
      return {ok: true};
    }
    case "notify": {
      var flag = EVENT_FLAG[b.event];
      if(!flag) throw W.httpErr(400, "不明な通知種別です");
      if(s[flag] === false || !s.channelId) return {ok: true, sent: false};
      await W.sendChannel(s.channelId, String(b.text || "").slice(0, 1500) + "\n（操作: " + who(me) + "）");
      return {ok: true, sent: true};
    }
    case "share": {
      if(!s.channelId) throw W.httpErr(400, "送り先のトークルームが未設定です。管理者に設定を依頼してください");
      var text = String(b.text || "").trim();
      if(!text) throw W.httpErr(400, "メッセージが空です");
      await W.sendChannel(s.channelId, "【共有】" + who(me) + " より\n" + text.slice(0, 1500));
      return {ok: true};
    }
    case "pairCode": {
      var code = String(Math.floor(100000 + Math.random() * 900000));
      var pair = await W.getDoc("settings/worksPair");
      var now = Date.now(), drop = [];
      Object.keys(pair).forEach(function(k){ if(k.indexOf("c_") === 0 && Number(String(pair[k]).split("|")[1]) < now) drop.push(k); });
      var data = {}; data["c_" + code] = me.name + "|" + (now + 10 * 60 * 1000);
      await W.patchDoc("settings/worksPair", data, drop);
      return {code: code, minutes: 10};
    }
    case "unlink": {
      var us = await W.getDoc("settings/worksUsers");
      var rm = Object.keys(us).filter(function(k){ return k.indexOf("u_") === 0 && us[k] === me.name; });
      if(rm.length) await W.patchDoc("settings/worksUsers", {}, rm);
      return {ok: true};
    }
    default:
      throw W.httpErr(400, "不明な操作です");
  }
}
