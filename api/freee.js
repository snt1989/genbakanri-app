// freee会計 連携API。POST /api/freee  { auth:{name,password}, action, ... }
// すべての操作で、管理者の氏名＋パスワードをサーバー側で照合します。
var F = require("./_freee");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
// 取引先名の「近さ」を判定する（株式会社・(株)・敬称・空白・全角半角の違いを無視）
function norm(s){
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/株式会社|有限会社|合同会社|一般社団法人|\(株\)|\(有\)|\(合\)|㈱|㈲/g, "")
    .replace(/御中|様|殿|さん/g, "")
    .replace(/[\s\u3000・･\-ー_.,、。()（）「」『』]/g, "");
}
function bigrams(s){ var o = {}; for(var i = 0; i < s.length - 1; i++) o[s.substr(i, 2)] = (o[s.substr(i, 2)] || 0) + 1; return o; }
function similarity(a, b){
  if(!a || !b) return 0;
  if(a === b) return 1;
  var short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if(short.length >= 2 && long.indexOf(short) !== -1) return Math.max(0.8, short.length / long.length);
  if(a.length < 2 || b.length < 2) return 0;
  var x = bigrams(a), y = bigrams(b), inter = 0, nx = 0, ny = 0;
  Object.keys(x).forEach(function(k){ nx += x[k]; if(y[k]) inter += Math.min(x[k], y[k]); });
  Object.keys(y).forEach(function(k){ ny += y[k]; });
  return (2 * inter) / (nx + ny);
}
function isoDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? s : ""; }

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    if(!F.configured()) return res.status(200).json({configured: false});
    var a = b.auth || {};
    if(!(await F.verifyAdmin(a.name, a.password))) return res.status(403).json({error: "管理者のみ利用できます（認証に失敗しました）"});
    var out = await run(b, req);
    res.status(200).json(out);
  }catch(e){
    res.status(e.status || 500).json({error: e.message || "error"});
  }
};

async function run(b, req){
  var t, cid;
  switch(b.action){
    case "status":
      t = await F.loadTokens();
      return {configured: true, connected: !!(t && t.refresh_token && t.companyId), companyName: t ? t.companyName || "" : "", connectedAt: t ? t.connectedAt || "" : "", redirectUri: F.redirectUri(req)};

    case "connect": {
      var u = F.AUTH_BASE + "/authorize?" + new URLSearchParams({client_id: F.env("FREEE_CLIENT_ID"), redirect_uri: F.redirectUri(req), response_type: "code", prompt: "select_company", state: F.makeState()}).toString();
      return {url: u};
    }
    case "disconnect":
      await F.fsDelete("settings/freeeAuth");
      return {ok: true};

    case "master": {
      t = await need();
      var items = await F.freee("GET", "/api/1/account_items", {query: {company_id: t.companyId}});
      var taxes = await F.freee("GET", "/api/1/taxes/companies/" + t.companyId);
      return {
        accountItems: (items.account_items || []).filter(function(x){ return x.available !== false; }).map(function(x){ return {id: x.id, name: x.name, category: x.account_category || ""}; }),
        taxes: (taxes.taxes || []).filter(function(x){ return x.available !== false; }).map(function(x){ return {code: x.code, name: x.name_ja || x.name}; })
      };
    }

    case "partners.check": {
      t = await need(); cid = t.companyId;
      var all = [], off = 0;
      for(var pg = 0; pg < 10; pg++){
        var page = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, limit: 3000, offset: off}});
        var arr = page.partners || []; all = all.concat(arr);
        if(arr.length < 3000) break; off += 3000;
      }
      var idx = all.map(function(p){ return {id: p.id, name: p.name, n: norm(p.name)}; });
      var out = (b.customers || []).slice(0, 100).map(function(c){
        var cn = norm(c.name), raw = String(c.name || "").trim();
        var cands = idx.map(function(p){ return {id: p.id, name: p.name, score: p.name === raw ? 1 : similarity(cn, p.n), exact: p.name === raw}; })
          .filter(function(x){ return x.score >= 0.6; })
          .sort(function(a, b){ return b.score - a.score; }).slice(0, 3);
        return {id: c.id, candidates: cands};
      });
      return {results: out, total: all.length};
    }

    case "partners.push": {
      t = await need(); cid = t.companyId;
      var list = (b.customers || []).slice(0, 40), results = [];
      for(var i = 0; i < list.length; i++){
        var c = list[i];
        try{
          var name = String(c.name || "").trim();
          if(!name) throw new Error("名前が空です");
          // 確認済み（force）でなければ、同名の取引先があればそれに紐づける
          var found = c.force ? {partners: []} : null;
          if(!found) found = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, keyword: name, limit: 50}});
          var same = (found.partners || []).find(function(p){ return p.name === name; });
          if(same){ results.push({id: c.id, partnerId: same.id, status: "linked"}); continue; }
          var body = {company_id: cid, name: name};
          if(c.kana) body.name_kana = String(c.kana).slice(0, 100);
          if(c.email) body.email = c.email;
          var addr = {};
          if(c.postalCode) addr.zipcode = String(c.postalCode).replace(/[^0-9-]/g, "");
          if(c.prefectureCode != null && c.prefectureCode !== "") addr.prefecture_code = c.prefectureCode;
          if(c.street1) addr.street_name1 = c.street1;
          if(c.street2) addr.street_name2 = c.street2;
          if(Object.keys(addr).length) body.address_attributes = addr;
          if(c.phone) body.phone = c.phone;
          var created = await F.freee("POST", "/api/1/partners", {body: body});
          results.push({id: c.id, partnerId: created.partner.id, status: "created"});
        }catch(e){ results.push({id: c.id, error: e.message}); if(e.status === 401) break; }
      }
      return {results: results};
    }

    case "deals.push": {
      t = await need(); cid = t.companyId;
      var s = b.settings || {};
      if(!s.accountItemId || s.taxCode == null || s.taxCode === "") throw F.httpErr(400, "勘定科目と税区分を設定してください");
      var ps = (b.projects || []).slice(0, 40), rs = [];
      for(var k = 0; k < ps.length; k++){
        var p = ps[k];
        try{
          var amount = Math.round(Number(p.amount));
          if(!(amount > 0)) throw new Error("金額が0円です");
          var issue = isoDate(p.issueDate); if(!issue) throw new Error("発生日がありません");
          var deal = {company_id: cid, issue_date: issue, type: "income", details: [{account_item_id: Number(s.accountItemId), tax_code: Number(s.taxCode), amount: amount, description: String(p.name || "").slice(0, 200)}]};
          if(p.partnerId) deal.partner_id = Number(p.partnerId);
          if(isoDate(p.dueDate)) deal.due_date = p.dueDate;
          if(p.ref) deal.ref_number = String(p.ref).slice(0, 20);
          var d = await F.freee("POST", "/api/1/deals", {body: deal});
          rs.push({id: p.id, dealId: d.deal.id});
        }catch(e){ rs.push({id: p.id, error: e.message}); if(e.status === 401) break; }
      }
      return {results: rs};
    }

    case "deals.status": {
      t = await need(); cid = t.companyId;
      var ids = (b.deals || []).slice(0, 60), st = [];
      for(var n = 0; n < ids.length; n++){
        try{
          var j = await F.freee("GET", "/api/1/deals/" + encodeURIComponent(ids[n].dealId), {query: {company_id: cid}});
          st.push({id: ids[n].id, status: j.deal.status, dueAmount: j.deal.due_amount, amount: j.deal.amount});
        }catch(e){ st.push({id: ids[n].id, error: e.message}); if(e.status === 401) break; }
      }
      return {results: st};
    }
  }
  throw F.httpErr(400, "unknown action");

  async function need(){
    var tk = await F.loadTokens();
    if(!tk || !tk.companyId) throw F.httpErr(409, "freeeと連携されていません");
    return tk;
  }
}
