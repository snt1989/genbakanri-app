// 社外メンバーの登録URL。POST /api/invite
//   create   … 管理者の氏名＋パスワードを照合し、7日間・1回だけ使える登録URLを発行する
//   check    … 登録URLが有効か確認する（ログイン前に呼ばれる）
//   register … 登録URLのトークンを確認して、社外メンバーを登録する（登録したURLは使えなくなる）
var crypto = require("crypto");
var F = require("./_freee");
var W = require("./_works");

var DAYS = 7;
function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function host(req){ return (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim(); }
function normPhone(v){
  var d = String(v || "").normalize("NFKC").replace(/[^0-9+]/g, "");
  if(d.indexOf("+81") === 0) d = "0" + d.slice(3);
  return d.replace(/\D/g, "");
}
function normName(v){ return String(v || "").normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase(); }
function bad(msg, status){ var e = new Error(msg); e.status = status || 400; return e; }
function s(v, max){ return String(v == null ? "" : v).trim().slice(0, max); }

async function loadInvite(token){
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) return null;
  var d = await W.getDoc("invites/" + token);
  if(!d || !d.expiresAt || d.used === true || Number(d.expiresAt) < Date.now()) return null;
  return d;
}

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    if(!W.env("FIREBASE_PROJECT_ID") || !W.env("FIREBASE_API_KEY")) return res.status(200).json({configured: false});
    if(b.action === "create"){
      var a = b.auth || {};
      var me = await F.verifyMember(a.name, a.password);
      if(!me || !F.isAdminMember(me)) return res.status(403).json({error: "管理者のみ発行できます"});
      var token = crypto.randomBytes(18).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      var expiresAt = Date.now() + DAYS * 86400000;
      await W.patchDoc("invites/" + token, {createdAt: new Date().toISOString(), createdBy: me.name, expiresAt: expiresAt, used: false});
      return res.status(200).json({url: "https://" + host(req) + "/?invite=" + token, expiresAt: expiresAt, days: DAYS});
    }
    if(b.action === "check"){
      return res.status(200).json({valid: !!(await loadInvite(b.token))});
    }
    if(b.action === "register"){
      var inv = await loadInvite(b.token);
      if(!inv) throw bad("この登録URLは無効か、有効期限が切れています。招待した方に、新しいURLを発行してもらってください。", 410);
      var name = s(b.name, 40), company = s(b.company, 60), phoneRaw = s(b.phone, 30), password = String(b.password == null ? "" : b.password).slice(0, 100);
      var phone = normPhone(phoneRaw);
      if(!name) throw bad("氏名を入力してください");
      if(!company) throw bad("所属会社を入力してください");
      if(phone.length < 10 || phone.length > 11) throw bad("携帯番号を正しく入力してください（例: 09012341234）");
      if(password.length < 4) throw bad("パスワードは4文字以上で入力してください");
      var members = await W.listDocs("members");
      if(members.some(function(m){ return normPhone(m.phone) === phone; })) throw bad("この携帯番号は、すでに登録されています");
      if(members.some(function(m){ return normName(m.name) === normName(name); })) throw bad("同じ氏名のメンバーがすでにいます。氏名の後ろに会社名などを付けて、区別してください");
      var roles = (Array.isArray(b.roles) ? b.roles : []).map(function(r){ return s(r, 20); }).filter(Boolean).slice(0, 10);
      var now = new Date().toISOString();
      // 先にURLを使用済みにして、同じURLでの二重登録を防ぐ
      await W.patchDoc("invites/" + b.token, {used: true, usedAt: now, usedBy: name});
      await W.createDoc("members", {name: name, kana: s(b.kana, 60), phone: phoneRaw, email: s(b.email, 100), company: company, roles: roles, password: password,
        permission: "external", isAdmin: false, kind: "external", invitedBy: inv.createdBy || "", createdAt: now, updatedAt: now});
      return res.status(200).json({ok: true});
    }
    throw bad("不明な操作です");
  }catch(e){
    res.status(e.status || 500).json({error: e.message || "error"});
  }
};
