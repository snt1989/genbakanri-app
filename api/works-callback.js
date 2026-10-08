// LINE WORKS Bot のコールバック（Webhook）。POST /api/works-callback
// 署名（X-WORKS-Signature = Base64(HMAC-SHA256(body, Bot Secret))）を検証してから処理します。
//   joined … Botがトークルームに追加された → そのルームを通知先に自動設定（未設定の場合）
//   message … 「ヘルプ」「連携 コード」「案件」「案件 名前」「タスク」「報告 案件名 内容」
var crypto = require("crypto");
var F = require("./_freee");
var W = require("./_works");

function rawBody(req){
  return new Promise(function(resolve, reject){
    var chunks = [];
    req.on("data", function(c){ chunks.push(c); });
    req.on("end", function(){ resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}
function validSig(raw, sig){
  var secret = W.env("WORKS_BOT_SECRET");
  if(!secret || !sig) return false;
  var want = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  return F.safeEq(want, String(sig));
}

var HELP = [
  "【現場管理アプリ Bot の使い方】",
  "・連携 123456 … アプリの「設定 > LINE WORKS」で出した6桁コードで本人確認(初回のみ)",
  "・案件 … 進行中の案件の一覧",
  "・案件 キーワード … 案件の詳細(進捗・工期・担当)",
  "・タスク … 期限が近い／過ぎたタスク　「タスク 自分」で自分の担当のみ",
  "・報告 案件名 内容 … 日報を登録(例: 報告 福川 本日は除草を完了)"
].join("\n");

var DONE_STATUS = ["清算済", "失注"];
function dateLabel(d){ return d ? d.slice(5).replace("-", "/") : "未定"; }

async function reply(src, text){
  if(src.channelId) return W.sendChannel(src.channelId, text);
  if(src.userId) return W.sendUser(src.userId, text);
}

async function handleText(src, text){
  var t = String(text || "").normalize("NFKC").trim();
  var m = /^(\S+)\s*([\s\S]*)$/.exec(t) || [];
  var cmd = m[1] || "", rest = (m[2] || "").trim();
  if(/^(ヘルプ|help|\?|使い方)$/i.test(cmd)) return reply(src, HELP);

  // ---- 本人確認（ワンタイムコード） ----
  if(cmd === "連携"){
    var code = rest.replace(/\D/g, "");
    var pair = await W.getDoc("settings/worksPair");
    var v = code && pair["c_" + code];
    if(!v || Number(String(v).split("|")[1]) < Date.now()) return reply(src, "コードが正しくないか、有効期限(10分)が切れています。アプリの「設定 > LINE WORKS」で新しいコードを発行してください。");
    var name = String(v).split("|")[0];
    var data = {}; data[W.userKey(src.userId)] = name;
    await W.patchDoc("settings/worksUsers", data);
    await W.patchDoc("settings/worksPair", {}, ["c_" + code]);
    return reply(src, name + " さんとして連携しました。「ヘルプ」でできることを確認できます。");
  }

  var name2 = src.userId ? await W.linkedName(src.userId) : "";
  if(!name2) return reply(src, "先に本人確認が必要です。アプリの「設定 > LINE WORKS」で6桁コードを発行し、「連携 123456」のように送ってください。");
  var members = await W.listDocs("members");
  var me = members.find(function(x){ return x.name === name2; });
  if(!me) return reply(src, "連携済みのメンバーが見つかりません。アプリで連携をやり直してください。");
  var projects = W.visibleProjects(await W.listDocs("projects"), me);

  if(cmd === "案件"){
    if(!rest){
      var act = projects.filter(function(p){ return DONE_STATUS.indexOf(p.status) === -1; });
      if(!act.length) return reply(src, "進行中の案件はありません。");
      var lines = act.slice(0, 25).map(function(p){ return "・" + p.name + "【" + (p.status || "未入力") + "】" + (p.endDate ? " 〜" + dateLabel(p.endDate) : ""); });
      return reply(src, "進行中の案件(" + act.length + "件)\n" + lines.join("\n") + (act.length > 25 ? "\n…ほか" + (act.length - 25) + "件" : "") + "\n\n詳細は「案件 キーワード」");
    }
    var k = W.strip(rest);
    var hit = projects.filter(function(p){ return W.strip(p.name).indexOf(k) !== -1 || W.strip(p.customerName).indexOf(k) !== -1; });
    if(!hit.length) return reply(src, "「" + rest + "」に当てはまる案件が見つかりません(担当している案件のみ表示されます)。");
    if(hit.length > 5) return reply(src, hit.length + "件に当てはまりました。もう少し絞ってください。\n" + hit.slice(0, 8).map(function(p){ return "・" + p.name; }).join("\n"));
    return reply(src, hit.map(function(p){
      return "【" + p.name + "】\n進捗: " + (p.status || "未入力") + (p.type ? " ／ " + p.type : "") + (p.store ? " ／ " + p.store : "") +
        "\n工期: " + dateLabel(p.startDate) + " 〜 " + dateLabel(p.endDate) + (p.address ? "\n住所: " + p.address : "") + "\n担当: " + (W.assigneeNames(p).join("、") || "未設定");
    }).join("\n\n"));
  }

  if(cmd === "タスク"){
    var ids = {}; projects.forEach(function(p){ ids[p.id] = 1; });
    var admin = F.isAdminMember(me);
    var tasks = (await W.listDocs("tasks")).filter(function(x){ return !x.done && (admin || !x.projectId || ids[x.projectId]); });
    if(/自分|my|私/.test(rest)) tasks = tasks.filter(function(x){ return W.strip(x.assignee) === W.strip(me.name); });
    var today = W.jstToday(0), lim = W.jstToday(7);
    tasks = tasks.filter(function(x){ return x.dueDate && x.dueDate <= lim; }).sort(function(a, b){ return a.dueDate.localeCompare(b.dueDate); });
    if(!tasks.length) return reply(src, "期限が近い(7日以内)・過ぎたタスクはありません。");
    return reply(src, "タスク(" + tasks.length + "件)\n" + tasks.slice(0, 20).map(function(x){
      return (x.dueDate < today ? "⚠期限超過 " : x.dueDate === today ? "本日 " : "") + dateLabel(x.dueDate) + " " + x.title + (x.assignee ? "(" + x.assignee + ")" : "") + (x.projectName ? " / " + x.projectName : "");
    }).join("\n"));
  }

  if(cmd === "報告"){
    var m2 = /^(\S+)\s+([\s\S]+)$/.exec(rest);
    if(!m2) return reply(src, "「報告 案件名 内容」の形で送ってください。(例: 報告 福川 本日は除草を完了)");
    var key = W.strip(m2[1]);
    var cand = projects.filter(function(p){ return DONE_STATUS.indexOf(p.status) === -1 && (W.strip(p.name).indexOf(key) !== -1 || W.strip(p.customerName).indexOf(key) !== -1); });
    if(!cand.length) return reply(src, "「" + m2[1] + "」に当てはまる進行中の案件がありません。「案件」で一覧を確認してください。");
    if(cand.length > 1) return reply(src, cand.length + "件に当てはまります。案件名をもう少し詳しく指定してください。\n" + cand.slice(0, 6).map(function(p){ return "・" + p.name; }).join("\n"));
    var p = cand[0], now = new Date().toISOString();
    await W.createDoc("reports", {type: "日報", date: W.jstToday(0), projectId: p.id, projectName: p.name, title: p.name + " 日報(LINE WORKS)", author: me.name, weather: "", workers: "",
      content: m2[2].trim(), result: "", issues: "", nextPlan: "", photos: [], status: "提出済", secret: false, createdAt: now, updatedAt: now});
    var s = await W.getSettings();
    if(s.channelId && s.notifyReport !== false && src.channelId !== s.channelId)
      await W.sendChannel(s.channelId, "【日報】" + me.name + "（LINE WORKSから登録）\n案件: " + p.name + "\n" + m2[2].trim().slice(0, 600));
    return reply(src, "「" + p.name + "」の日報を登録しました。");
  }

  return reply(src, "コマンドが分かりませんでした。「ヘルプ」と送ると使い方を表示します。");
}

module.exports = async function handler(req, res){
  if(req.method !== "POST") return res.status(405).end();
  var raw = await rawBody(req);
  if(!validSig(raw, req.headers["x-works-signature"])) return res.status(401).end();
  try{
    var ev = JSON.parse(raw.toString("utf8"));
    var src = ev.source || {};
    if(ev.type === "joined" && src.channelId){
      var s = await W.getSettings();
      if(!s.channelId){
        await W.patchDoc("settings/works", {channelId: src.channelId});
        await W.sendChannel(src.channelId, "現場管理アプリと連携しました。このトークルームを通知先に設定しました。「ヘルプ」で使い方を確認できます。");
      }
    }else if(ev.type === "message" && ev.content && ev.content.type === "text"){
      await handleText(src, ev.content.text);
    }
  }catch(e){ console.error("works callback", e.message); }
  res.status(200).end();   // 処理が終わってから応答（サーバーレスでは応答後の処理が止まるため）。失敗はログに残す
};
module.exports.config = {api: {bodyParser: false}};
