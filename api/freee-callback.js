// freee の認可画面から戻ってくる先（OAuth redirect URI）。
var F = require("./_freee");
module.exports = async function handler(req, res){
  var back = function(q){ res.statusCode = 302; res.setHeader("Location", "/?freee=" + q); res.end(); };
  try{
    var q = req.query || {};
    if(q.error) return back("denied");
    if(!F.configured() || !F.checkState(q.state) || !q.code) return back("invalid");
    var t = await F.exchangeCode(q.code, F.redirectUri(req));
    await F.saveTokens(t, {connectedAt: new Date().toISOString()});
    // 事業所を取得して保存（複数ある場合は最初の事業所）
    var cs = await F.freee("GET", "/api/1/companies");
    var c = (cs.companies || [])[0];
    if(!c) return back("nocompany");
    await F.saveTokens({}, {companyId: c.id, companyName: c.display_name || c.name || ""});
    back("ok");
  }catch(e){
    console.error("freee callback", e && e.message);
    back("error");
  }
};
