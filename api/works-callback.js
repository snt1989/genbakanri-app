// LINE WORKS Bot のコールバック（Webhook）。POST /api/works-callback
// 署名（X-WORKS-Signature = Base64(HMAC-SHA256(body, Bot Secret))）を検証してから処理します。
//   join … Botがグループ/複数人トークルームに招待された → そのルームを通知先に自動設定（未設定の場合）
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
  "・報告 案件名 内容 … 日報を登録(例: 報告 福川 本日は除草を完了)",
  "・案件登録 … 案件を新規登録(「案件登録」だけ送ると書き方が出ます)"
].join("\n");

/* ---- 案件登録（決まった書き方のメッセージ） ---- */
var PROJECT_TYPES = ["原状回復工事", "除草・草刈作業", "植栽維持管理", "建物・敷地清掃", "排水管清掃", "解体工事", "その他"];
var STATUS_LIST = ["現地調査前", "現地調査済", "見積提出済", "契約済", "施工中", "施工完了", "清算済", "失注"];
var STORES = ["盛岡店", "仙台店", "秋田店", "本社"];
var PREFS = ["北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県","埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県","岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県","鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県","佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"];
var LABELS = {name: ["案件名", "名称", "物件名", "件名"], customer: ["顧客", "顧客名", "取引先", "お客様", "客先"], address: ["住所", "現場住所", "所在地", "現場"], type: ["種類", "案件種類", "種別"],
  status: ["進捗", "ステータス", "状況"], store: ["店舗", "担当店舗"], amount: ["金額", "請求金額", "売上"], period: ["工期", "期間"], start: ["開始", "開始日", "着工", "着工日"], end: ["終了", "終了日", "完了", "完了日", "完工日"],
  assignees: ["担当", "担当者", "メンバー"], phone: ["電話", "電話番号", "tel", "TEL", "連絡先"], note: ["指示", "作業指示", "内容", "備考", "メモ"]};
var TEMPLATE = ["案件登録", "案件名: ○○様邸 除草作業", "顧客: 福川 伸夫", "住所: 岩手県盛岡市箱清水1-7-16", "種類: 除草・草刈作業", "進捗: 現地調査前", "店舗: 盛岡店", "金額: 178200",
  "工期: 2026-10-01 〜 2026-10-05", "担当: 阿部 晋太郎、鷹羽 悠希", "電話: 090-1234-5678", "指示: 作業内容のメモ"].join("\n");

function labelKey(label){
  var l = String(label).normalize("NFKC").trim().toLowerCase();
  var keys = Object.keys(LABELS);
  for(var i = 0; i < keys.length; i++) if(LABELS[keys[i]].some(function(x){ return x.toLowerCase() === l; })) return keys[i];
  return "";
}
function parseFields(text){
  var out = {}, last = "";
  String(text).split(/\r?\n/).slice(1).forEach(function(line){
    var m = /^\s*([^:：]{1,10})[:：]\s*([\s\S]*)$/.exec(line), k = m ? labelKey(m[1]) : "";
    if(k){ out[k] = m[2].trim(); last = k; }
    else if(last === "note" && line.trim()) out.note += "\n" + line.trim();   // 指示は複数行OK
  });
  return out;
}
function pickOne(val, list){
  var v = W.strip(val); if(!v) return "";
  var hit = list.find(function(x){ return W.strip(x) === v; }) || list.filter(function(x){ return W.strip(x).indexOf(v) !== -1 || v.indexOf(W.strip(x)) !== -1; });
  return Array.isArray(hit) ? (hit.length === 1 ? hit[0] : "") : hit;
}
function parseDate(s){
  var t = String(s || "").normalize("NFKC").trim(), m;
  if((m = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(t))) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  if((m = /^(\d{1,2})[\/月](\d{1,2})日?$/.exec(t))) return W.jstToday(0).slice(0, 4) + "-" + ("0" + m[1]).slice(-2) + "-" + ("0" + m[2]).slice(-2);
  return "";
}
async function registerProject(src, me, text){
  if(!/\n/.test(String(text).trim())) return reply(src, "案件を登録するには、次の形で送ってください(案件名と顧客は必須。他は省略できます)。\n\n" + TEMPLATE);
  var perm = me.permission || (me.isAdmin ? "admin" : (me.kind === "external" ? "external" : "general"));
  if(perm === "external") return reply(src, "外部メンバーは、案件の登録ができません。");
  var f = parseFields(text), notes = [];
  if(!f.name || !f.customer) return reply(src, "「案件名」と「顧客」は必須です。「案件登録」だけを送ると、書き方が出ます。");
  var all = await W.listDocs("projects");
  if(all.some(function(p){ return W.strip(p.name) === W.strip(f.name); })) return reply(src, "同じ名前の案件がすでにあります。(二重登録を防ぐため、登録しませんでした)\n" + f.name);
  var type = f.type ? pickOne(f.type, PROJECT_TYPES) : "";
  if(f.type && !type){ type = "その他"; notes.push("種類「" + f.type + "」は一覧にないため「その他」にしました"); }
  var status = f.status ? pickOne(f.status, STATUS_LIST) : "現地調査前";
  if(!status){ status = "現地調査前"; notes.push("進捗「" + f.status + "」は一覧にないため「現地調査前」にしました"); }
  var store = f.store ? pickOne(f.store, STORES) : "";
  if(f.store && !store) notes.push("店舗「" + f.store + "」は一覧にないため未設定にしました");
  var amount = 0;
  if(f.amount){ amount = parseInt(String(f.amount).normalize("NFKC").replace(/[,，¥￥円\s]/g, ""), 10); if(!(amount >= 0)){ amount = 0; notes.push("金額を読み取れませんでした"); } }
  var start = f.start ? parseDate(f.start) : "", end = f.end ? parseDate(f.end) : "";
  if(f.period){
    var pr = String(f.period).normalize("NFKC").replace(/まで/g, "").split(/\s*[〜~～]\s*|\s+から\s+|\s+[-–—ー]\s+/).filter(Boolean);
    if(pr.length) start = start || parseDate(pr[0]); if(pr.length > 1) end = end || parseDate(pr[1]);
  }
  if((f.start && !start) || (f.end && !end) || (f.period && !start && !end)) notes.push("日付を読み取れなかった項目があります(例: 2026-10-01)");
  // 担当者
  var members = await W.listDocs("members"), assignees = [], missing = [];
  (f.assignees || "").split(/[、,，\/]/).map(function(x){ return x.trim(); }).filter(Boolean).forEach(function(n){
    var k = W.strip(n), hit = members.filter(function(x){ return W.strip(x.name) === k; });
    if(!hit.length) hit = members.filter(function(x){ return W.strip(x.name).indexOf(k) !== -1; });
    if(hit.length === 1){ if(!assignees.some(function(a){ return a.name === hit[0].name; })) assignees.push({name: hit[0].name, kind: hit[0].kind || "internal", status: "未確認"}); }
    else missing.push(n);
  });
  if(missing.length) notes.push("担当者が特定できず、外しました: " + missing.join("、"));
  if(perm !== "admin" && !assignees.some(function(a){ return a.name === me.name; })) assignees.push({name: me.name, kind: me.kind || "internal", status: "確認済"});
  // 顧客（同名があれば紐づけ、なければ新規作成）
  var customers = await W.listDocs("customers"), cust = customers.find(function(c){ return W.strip(c.name) === W.strip(f.customer); }), cid, cdata;
  var addr = f.address || "", pref = PREFS.find(function(x){ return addr.indexOf(x) === 0; }) || "";
  if(pref) addr = addr.slice(pref.length);
  if(cust){ cid = cust.id; cdata = cust; }
  else{
    cdata = {name: f.customer, prefecture: pref, address: addr, phone: f.phone || "", registeredDate: W.jstToday(0)};
    cid = await W.createDoc("customers", Object.assign({createdAt: new Date().toISOString()}, cdata));
    notes.push("顧客「" + f.customer + "」を新規登録しました");
  }
  var KEYS = {name: "customerName", kana: "customerKana", postalCode: "postalCode", prefecture: "prefecture", address: "address", building: "building", phone: "customerPhone", email: "customerEmail",
    contactName: "customerContactName", department: "customerDepartment"};
  var now = new Date().toISOString();
  var rec = {name: f.name, assignees: assignees, type: type || "その他", status: status, store: store, amount: amount || 0, startDate: start, endDate: end, workInstruction: f.note || "", handoverDate: "",
    customerId: cid || "", secretFields: {}, addressMode: "same", createdAt: now, updatedAt: now, source: "LINE WORKS"};
  Object.keys(KEYS).forEach(function(k){ rec[KEYS[k]] = cdata[k] != null ? cdata[k] : ""; });
  if(cust && f.address){ rec.prefecture = pref || rec.prefecture; rec.address = addr || rec.address; }   // 案件ごとの住所を優先
  if(!cust){ rec.customerName = f.customer; }
  await W.createDoc("projects", rec);
  var s = await W.getSettings();
  if(s.channelId && s.notifyStatus !== false && src.channelId !== s.channelId)
    await W.sendChannel(s.channelId, "【案件登録】" + f.name + "（" + status + "）\n顧客: " + f.customer + "（LINE WORKSから登録: " + me.name + "）");
  return reply(src, "案件を登録しました。\n【" + f.name + "】\n顧客: " + f.customer + "\n進捗: " + status + " ／ 種類: " + rec.type + (store ? " ／ " + store : "") +
    (amount ? "\n金額: " + amount.toLocaleString("ja-JP") + "円" : "") + (start || end ? "\n工期: " + (start || "未定") + " 〜 " + (end || "未定") : "") +
    "\n担当: " + (assignees.map(function(a){ return a.name; }).join("、") || "未設定") + (notes.length ? "\n\n※ " + notes.join("\n※ ") : "") + "\n\n詳しい情報は、アプリの案件画面で追加・修正できます。");
}

// 受信の状況を1件だけ記録（管理者が設定画面で確認できる。原因調査用）
async function note(msg){
  try{ await W.patchDoc("settings/worksDebug", {at: new Date().toISOString(), msg: String(msg).slice(0, 300)}); }catch(e){}
}

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

  if(cmd === "案件登録") return registerProject(src, me, t);

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
  if(!validSig(raw, req.headers["x-works-signature"])){
    await note(W.env("WORKS_BOT_SECRET") ? "署名が一致しません（WORKS_BOT_SECRET が Bot の Secret と違う可能性）" : "WORKS_BOT_SECRET が未設定です");
    return res.status(401).end();
  }
  try{
    var ev = JSON.parse(raw.toString("utf8"));
    var src = ev.source || {};
    await note("受信 type=" + ev.type + (ev.content && ev.content.text ? " 「" + String(ev.content.text).slice(0, 30) + "」" : ""));
    if(ev.type === "join" && src.channelId){
      var s = await W.getSettings();
      if(!s.channelId){
        await W.patchDoc("settings/works", {channelId: src.channelId});
        await W.sendChannel(src.channelId, "現場管理アプリと連携しました。このトークルームを通知先に設定しました。「ヘルプ」で使い方を確認できます。");
      }
    }else if(ev.type === "message" && ev.content && ev.content.type === "text"){
      await handleText(src, ev.content.text);
    }
    await note("処理OK type=" + ev.type);
  }catch(e){ console.error("works callback", e.message); await note("処理エラー: " + e.message); }
  res.status(200).end();   // 処理が終わってから応答（サーバーレスでは応答後の処理が止まるため）。失敗はログに残す
};
module.exports.config = {api: {bodyParser: false}};
