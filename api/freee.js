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
// freeeの取引先 → アプリの顧客に反映できる項目
function partnerInfo(p){
  var ad = p.address_attributes || p.address || {};
  return {kana: p.name_kana || "", email: p.email || "", phone: p.phone || "", zipcode: ad.zipcode || "",
    prefectureCode: ad.prefecture_code == null ? "" : ad.prefecture_code, street1: ad.street_name1 || "", street2: ad.street_name2 || "", updateDate: isoDate(p.update_date)};
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

// 見積書を作成した履歴のある取引先 { 取引先ID: {n:件数, last:最新の発行日} }（freee会計の見積書API → だめなら請求書APIを試す）
async function quotedPartners(cid){
  var paths = ["/api/1/quotations", "/iv/quotations"], lastErr = null;
  for(var pi = 0; pi < paths.length; pi++){
    try{
      var map = {}, off = 0;
      for(var pg = 0; pg < 100; pg++){
        var r = await F.freee("GET", paths[pi], {query: {company_id: cid, limit: 100, offset: off}});
        var arr = r.quotations || [];
        arr.forEach(function(q){
          var id = q.partner_id; if(!id) return;
          var d = String(q.quotation_date || q.issue_date || q.created_at || "").slice(0, 10);
          var e = map[id] || (map[id] = {n: 0, last: ""}); e.n++; if(d > e.last) e.last = d;
        });
        if(arr.length < 100) break; off += 100;
      }
      return map;
    }catch(e){ lastErr = e; if(e.status === 401) throw e; }
  }
  throw F.httpErr(502, "見積書の履歴を取得できませんでした（" + (lastErr ? lastErr.message : "") + "）。freeeアプリの権限に見積書（請求書）の読み取りが必要な場合があります");
}

var DOC_KINDS = {
  quotation: {label: "見積書", path: "quotations", one: "quotation", num: "quotation_number", date: "quotation_date", due: "expiration_date"},
  invoice: {label: "請求書", path: "invoices", one: "invoice", num: "invoice_number", date: "billing_date", due: "payment_date"},
  purchase_order: {label: "発注書", path: "purchase_orders", one: "purchase_order", num: "purchase_order_number", date: "purchase_order_date", due: "collects_on"},
  delivery_slip: {label: "納品書", path: "delivery_slips", one: "delivery_slip", num: "delivery_slip_number", date: "delivery_slip_date", due: ""},
  receipt: {label: "領収書", path: "receipts", one: "receipt", num: "receipt_number", date: "receipt_date", due: ""}
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
      var idx = all.map(function(p){ return {id: p.id, name: p.name, n: norm(p.name), info: partnerInfo(p)}; });
      var out = (b.customers || []).slice(0, 100).map(function(c){
        var cn = norm(c.name), raw = String(c.name || "").trim();
        var cands = idx.map(function(p){ return {id: p.id, name: p.name, info: p.info, score: p.name === raw ? 1 : similarity(cn, p.n), exact: p.name === raw}; })
          .filter(function(x){ return x.score >= 0.6; })
          .sort(function(a, b){ return b.score - a.score; }).slice(0, 3);
        return {id: c.id, candidates: cands};
      });
      return {results: out, total: all.length};
    }

    case "partners.dates": {   // 連携済みの取引先の freee 最終更新日 { 取引先ID: "YYYY-MM-DD" }
      t = await need(); cid = t.companyId;
      var want = {}; (b.ids || []).slice(0, 5000).forEach(function(i){ want[String(i)] = 1; });
      var dm = {}, of2 = 0;
      for(var pg3 = 0; pg3 < 10; pg3++){
        var pd = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, limit: 3000, offset: of2}});
        var ap = pd.partners || [];
        ap.forEach(function(p){ if(want[String(p.id)] && isoDate(p.update_date)) dm[p.id] = p.update_date; });
        if(ap.length < 3000) break; of2 += 3000;
      }
      return {dates: dm};
    }

    case "partners.list": {
      t = await need(); cid = t.companyId;
      var quoted = null;
      if(b.onlyQuoted) quoted = await quotedPartners(cid);
      var got = [], offs = 0;
      for(var pg2 = 0; pg2 < 10; pg2++){
        var pgd = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, limit: 3000, offset: offs}});
        var ar = pgd.partners || []; got = got.concat(ar);
        if(ar.length < 3000) break; offs += 3000;
      }
      return {total: got.length, quotedOnly: !!quoted, partners: got.filter(function(p){ return p.available !== false && String(p.name || "").trim() && (!quoted || quoted[p.id]); }).map(function(p){
        var ad = p.address_attributes || p.address || {};
        return {id: p.id, name: String(p.name).trim(), updateDate: isoDate(p.update_date), kana: p.name_kana || "", email: p.email || "", phone: p.phone || "",
          zipcode: ad.zipcode || "", prefectureCode: ad.prefecture_code == null ? "" : ad.prefecture_code, street1: ad.street_name1 || "", street2: ad.street_name2 || "",
          quoteCount: quoted && quoted[p.id] ? quoted[p.id].n : 0, lastQuote: quoted && quoted[p.id] ? quoted[p.id].last : ""};
      })};
    }

    // freeeの見積書・発注書を「取消」にする（freeeのAPIには削除がないため。freeeの画面で取消の解除もできる）
    // { kind:"quotation"|"purchase_order", id }
    case "docs.cancel": {
      t = await need(); cid = t.companyId;
      var ck = b.kind === "purchase_order" ? "purchase_orders" : (b.kind === "quotation" ? "quotations" : "");
      var did = Number(b.id) || 0;
      if(!ck || !did) throw F.httpErr(400, "取り消す書類を指定してください");
      try{ await F.freee("PUT", "/iv/" + ck + "/" + did + "/cancel", {body: {company_id: cid}}); }
      catch(e){
        if(/すでに|既に|already|取消|cancel/i.test(String(e.message || ""))) return {ok: true, already: true};
        if(e.status === 401 || /アクセス権限/.test(String(e.message || ""))) throw F.httpErr(e.status === 401 ? 401 : 403, "freeeアプリに「請求書」の更新権限がありません（" + e.message + "）");
        throw e;
      }
      return {ok: true};
    }

    // 見積書・発注書を、freee請求書API（/iv）に「下書き」として作成する（送付はfreee側で行う）
    // { kind:"quotation"|"purchase_order", partnerId?, partnerName?, subject, date, dueDate?, memo?, note?, lines:[{description, quantity, unit, unitPrice, taxRate}] }
    case "docs.create": {
      t = await need(); cid = t.companyId;
      var kind = b.kind === "purchase_order" ? "purchase_orders" : (b.kind === "quotation" ? "quotations" : "");
      if(!kind) throw F.httpErr(400, "書類の種類が正しくありません");
      var lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 100).map(function(l){
        var q = Number(l.quantity), up = Number(l.unitPrice);
        return {type: "item", description: String(l.description || "").slice(0, 200), quantity: isFinite(q) && q > 0 ? q : 1, unit: String(l.unit || "").slice(0, 10),
          unit_price: String(isFinite(up) ? up : 0), tax_rate: [0, 8, 10].indexOf(Number(l.taxRate)) !== -1 ? Number(l.taxRate) : 10, reduced_tax_rate: false, withholding: false};
      }).filter(function(l){ return l.description; });
      if(!lines.length) throw F.httpErr(400, "明細がありません");
      var date = isoDate(b.date); if(!date) throw F.httpErr(400, "発行日を入力してください");
      var pid = Number(b.partnerId) || 0, pname = String(b.partnerName || "").trim();
      if(!pid){
        if(!pname) throw F.httpErr(400, "取引先を指定してください");
        var fp = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, keyword: pname, limit: 50}});
        var nn = norm(pname), hit = (fp.partners || []).filter(function(p){ return p.available !== false; }).map(function(p){ return {p: p, s: similarity(norm(p.name), nn)}; }).sort(function(x, y){ return y.s - x.s; })[0];
        if(!hit || hit.s < 0.85) throw F.httpErr(400, "freeeに取引先「" + pname + "」が見つかりません。freeeに取引先を登録するか、顧客を「freeeと連携」してください");
        pid = hit.p.id;
      }
      var editId = Number(b.docId) || 0;   // 指定があれば、作成済みの書類を更新（PUT）する
      var tpl = null;
      if(!editId) try{ var tl = await F.freee("GET", "/iv/" + kind + "/templates", {query: {company_id: cid}}); tpl = (tl.templates || [])[0] || null; }catch(e){ if(e.status === 401) throw e; }
      var body = {company_id: cid, partner_id: pid, partner_title: "御中", subject: String(b.subject || "").slice(0, 100), memo: String(b.memo || "").slice(0, 1000),
        tax_entry_method: "out", tax_fraction: "omit", line_amount_fraction: "omit", withholding_tax_entry_method: "out", lines: lines};
      if(tpl) body.template_id = tpl.id;
      if(kind === "quotations"){
        body.quotation_date = date; if(isoDate(b.dueDate)) body.expiration_date = b.dueDate; if(b.note) body.quotation_note = String(b.note).slice(0, 1000);
      }else{
        body.purchase_order_date = date; if(isoDate(b.dueDate)) body.collects_on = b.dueDate; if(b.note) body.purchase_order_note = String(b.note).slice(0, 1000);
      }
      var cr;
      try{ cr = editId ? await F.freee("PUT", "/iv/" + kind + "/" + editId, {body: body}) : await F.freee("POST", "/iv/" + kind, {body: body}); }
      catch(e){
        if(/アクセス権限|権限がない|forbidden|insufficient/i.test(String(e.message || "")) || e.status === 403 || e.status === 401) throw F.httpErr(e.status === 401 ? 401 : 403, "freeeのアプリに「請求書」の書き込み権限がありません。freeeの開発者ページでアプリの権限に「請求書」（参照・更新）を追加し、アプリの「設定 → freee連携」でもう一度連携してください（" + e.message + "）");
        throw e;
      }
      var doc = cr.quotation || cr.purchase_order || cr;
      return {updated: !!editId, id: doc.id || editId, number: doc.quotation_number || doc.purchase_order_number || "", url: doc.report_url || "", total: doc.total_amount == null ? null : doc.total_amount, partnerId: pid};
    }

    // 取引先を指定して、freeeの請求書API（/iv）にある書類（見積書・請求書・発注書・納品書・領収書）を一覧する（読み取りのみ）
    // { partnerId? | partnerName?, kinds?:["quotation","invoice",...] }
    case "docs.list": {
      t = await need(); cid = t.companyId;
      var pid2 = Number(b.partnerId) || 0, pn2 = String(b.partnerName || "").trim();
      if(!pid2){
        if(!pn2) throw F.httpErr(400, "取引先を指定してください");
        var fp2 = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, keyword: pn2, limit: 50}});
        var nn2 = norm(pn2), hit2 = (fp2.partners || []).filter(function(p){ return p.available !== false; }).map(function(p){ return {p: p, s: similarity(norm(p.name), nn2)}; }).sort(function(x, y){ return y.s - x.s; })[0];
        if(!hit2 || hit2.s < 0.85) throw F.httpErr(400, "freeeに取引先「" + pn2 + "」が見つかりません");
        pid2 = hit2.p.id;
      }
      var want2 = (Array.isArray(b.kinds) && b.kinds.length ? b.kinds : Object.keys(DOC_KINDS)).filter(function(k){ return DOC_KINDS[k]; });
      var docs = [], truncated = false, errs = [];
      await Promise.all(want2.map(async function(k){
        var K = DOC_KINDS[k], off3 = 0, usePid = true;
        try{
          for(var pg4 = 0; pg4 < 15; pg4++){
            var q = {company_id: cid, limit: 100, offset: off3}; if(usePid) q.partner_id = pid2;
            var r;
            try{ r = await F.freee("GET", "/iv/" + K.path, {query: q}); }
            catch(e){ if(usePid && e.status === 400){ usePid = false; q = {company_id: cid, limit: 100, offset: off3}; r = await F.freee("GET", "/iv/" + K.path, {query: q}); } else throw e; }
            var arr3 = r[K.path] || [];
            arr3.forEach(function(o){
              if(Number(o.partner_id) !== pid2) return;
              docs.push({kind: k, id: o.id, number: o[K.num] || "", subject: o.subject || "", date: String(o[K.date] || o.issue_date || o.billing_date || "").slice(0, 10),
                dueDate: String(o[K.due] || "").slice(0, 10), total: o.total_amount == null ? (o.amount_including_tax == null ? null : o.amount_including_tax) : o.total_amount,
                cancel: o.cancel_status === "canceled", sending: o.sending_status || "", payment: o.payment_status || "", url: o.report_url || "",
                partnerId: o.partner_id, partnerName: o.partner_display_name || o.partner_name || ""});
            });
            if(arr3.length < 100) break; off3 += 100;
            if(pg4 === 14) truncated = true;
          }
        }catch(e){ if(e.status === 401) throw e; errs.push(K.label + "：" + (e.message || "取得できませんでした")); }
      }));
      docs.sort(function(a, b2){ return String(b2.date).localeCompare(String(a.date)) || (b2.id - a.id); });
      return {partnerId: pid2, docs: docs, truncated: truncated, errors: errs};
    }

    // 書類1件の明細つき内容（読み取りのみ） { kind, id }
    case "docs.get": {
      t = await need(); cid = t.companyId;
      var K2 = DOC_KINDS[b.kind], did2 = Number(b.id) || 0;
      if(!K2 || !did2) throw F.httpErr(400, "書類を指定してください");
      var gr = await F.freee("GET", "/iv/" + K2.path + "/" + did2, {query: {company_id: cid}});
      var o2 = gr[K2.one] || gr;
      return {doc: {kind: b.kind, id: o2.id, number: o2[K2.num] || "", subject: o2.subject || "", date: String(o2[K2.date] || o2.issue_date || o2.billing_date || "").slice(0, 10),
        total: o2.total_amount == null ? null : o2.total_amount, partnerId: o2.partner_id, partnerName: o2.partner_display_name || o2.partner_name || "", memo: o2.memo || "", url: o2.report_url || "",
        lines: (o2.lines || []).filter(function(l){ return l.type === "item"; }).map(function(l){
          var q2 = Number(l.quantity), up2 = Number(l.unit_price), amt2 = l.amount_excluding_tax != null ? Number(l.amount_excluding_tax) : (isFinite(q2) && isFinite(up2) ? Math.round((q2 || 1) * up2) : 0);
          return {description: String(l.description || ""), quantity: isFinite(q2) && q2 > 0 ? q2 : 1, unit: l.unit || "", unitPrice: isFinite(up2) ? up2 : 0, taxRate: l.tax_rate == null ? 10 : l.tax_rate, amount: amt2 || 0};
        })}};
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
          if(same){ results.push({id: c.id, partnerId: same.id, status: "linked", info: partnerInfo(same)}); continue; }
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
          results.push({id: c.id, partnerId: created.partner.id, status: "created", info: partnerInfo(created.partner)});
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

    // 経費（支出）の取引の明細を期間で取得する。予算管理の「実績」として取り込むため。 { start, end } → { items:[{dealId, detailId, date, accountName, amount, description, partner, tags}] }
    case "deals.expenses": {
      t = await need(); cid = t.companyId;
      var s0 = isoDate(b.start), e0 = isoDate(b.end);
      if(!s0 || !e0 || s0 > e0) throw F.httpErr(400, "期間を正しく指定してください");
      var acc = {}, tagMap = {}, partnerMap = {}, secMap = {};
      var ai = await F.freee("GET", "/api/1/account_items", {query: {company_id: cid}});
      (ai.account_items || []).forEach(function(x){ acc[x.id] = x.name; });
      try{ var tg = await F.freee("GET", "/api/1/tags", {query: {company_id: cid, limit: 3000}}); (tg.tags || []).forEach(function(x){ tagMap[x.id] = x.name; }); }catch(e){ if(e.status === 401) throw e; }
      try{ var sc = await F.freee("GET", "/api/1/sections", {query: {company_id: cid}}); (sc.sections || []).forEach(function(x){ secMap[x.id] = x.name; }); }catch(e){ if(e.status === 401) throw e; }
      try{ var pr = await F.freee("GET", "/api/1/partners", {query: {company_id: cid, limit: 3000}}); (pr.partners || []).forEach(function(x){ partnerMap[x.id] = x.name; }); }catch(e){ if(e.status === 401) throw e; }
      var out = [], off = 0, truncated = false;
      for(var pg = 0; pg < 10; pg++){
        var r = await F.freee("GET", "/api/1/deals", {query: {company_id: cid, type: "expense", start_issue_date: s0, end_issue_date: e0, limit: 100, offset: off}});
        var ds = r.deals || [];
        ds.forEach(function(d){
          (d.details || []).forEach(function(x){
            out.push({dealId: d.id, detailId: x.id, date: isoDate(d.issue_date), accountName: acc[x.account_item_id] || "", amount: Number(x.amount) || 0, description: String(x.description || ""),
              partner: d.partner_id ? (partnerMap[d.partner_id] || "") : "", section: x.section_id ? (secMap[x.section_id] || "") : "", tags: (x.tag_ids || []).map(function(i){ return tagMap[i]; }).filter(Boolean)});
          });
        });
        if(ds.length < 100) break; off += 100;
        if(pg === 9) truncated = true;
      }
      out.sort(function(a, b){ return String(b.date).localeCompare(String(a.date)); });
      return {items: out.slice(0, 1500), truncated: truncated || out.length > 1500};
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
