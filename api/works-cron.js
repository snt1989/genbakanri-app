// 毎朝(日本時間8時)の自動通知。Vercel Cron が GET /api/works-cron を呼び出す（vercel.json）。
// 呼び出し元の確認: Vercel は環境変数 CRON_SECRET を "Authorization: Bearer ..." として付けて呼びます。
var F = require("./_freee");
var W = require("./_works");

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  var secret = W.env("CRON_SECRET");
  if(!secret) return res.status(503).json({error: "CRON_SECRET が未設定です"});
  if(!F.safeEq(req.headers.authorization || "", "Bearer " + secret)) return res.status(401).json({error: "unauthorized"});
  try{
    if(!W.configured()) return res.status(200).json({skipped: "not configured"});
    var s = await W.getSettings();
    if(!s.channelId || s.notifyDigest === false) return res.status(200).json({skipped: "disabled"});
    var today = W.jstToday(0), soon = W.jstToday(1), lim = W.jstToday(3);
    var tasks = (await W.listDocs("tasks")).filter(function(t){ return !t.done && t.dueDate && t.dueDate <= soon; }).sort(function(a, b){ return a.dueDate.localeCompare(b.dueDate); });
    var ends = (await W.listDocs("projects")).filter(function(p){ return p.endDate && p.endDate >= today && p.endDate <= lim && ["施工中", "契約済", "施工完了"].indexOf(p.status) !== -1; }).sort(function(a, b){ return a.endDate.localeCompare(b.endDate); });
    if(!tasks.length && !ends.length) return res.status(200).json({sent: false});
    var md = function(d){ return d.slice(5).replace("-", "/"); };
    var lines = ["【" + md(today) + " 今日の確認】"];
    if(tasks.length){
      lines.push("■ タスク(期限が今日・明日・超過)");
      tasks.slice(0, 20).forEach(function(t){ lines.push("・" + (t.dueDate < today ? "⚠超過 " : t.dueDate === today ? "本日 " : "明日 ") + t.title + (t.assignee ? "(" + t.assignee + ")" : "") + (t.projectName ? " / " + t.projectName : "")); });
    }
    if(ends.length){
      lines.push("■ 工期の終了が近い案件(3日以内)");
      ends.slice(0, 15).forEach(function(p){ lines.push("・" + md(p.endDate) + " " + p.name + "【" + p.status + "】"); });
    }
    await W.sendChannel(s.channelId, lines.join("\n"));
    res.status(200).json({sent: true, tasks: tasks.length, projects: ends.length});
  }catch(e){
    console.error("works cron", e.message);
    res.status(500).json({error: e.message});
  }
};
