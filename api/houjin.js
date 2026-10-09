// 法人番号 → 法人情報の検索（国税庁 法人番号公表サイト Web-API）。POST /api/houjin { auth:{name,password}, number:"1234567890123" }
// 必要な環境変数: HOUJIN_APP_ID（国税庁に無料で申請するアプリケーションID）。申請方法は HOUJIN.md を参照。
var F = require("./_freee");

function readBody(req){
  if(req.body && typeof req.body === "object") return req.body;
  try{ return JSON.parse(req.body || "{}"); }catch(e){ return {}; }
}
function unxml(s){
  return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function(_, n){ return String.fromCharCode(+n); }).replace(/&amp;/g, "&");
}
function tag(xml, name){
  var m = new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">").exec(xml);
  return m ? unxml(m[1]).trim() : "";
}
// 先頭1桁がチェックデジット
function validNumber(n){
  if(!/^\d{13}$/.test(n)) return false;
  var s = 0;
  for(var i = 1; i <= 12; i++){
    var p = +n[12 - (i - 1)];              // 右から i 番目（13桁目が1番）
    s += p * (i % 2 === 1 ? 1 : 2);
  }
  return (9 - (s % 9)) === +n[0];
}
var KINDS = {"101": "国の機関", "201": "地方公共団体", "301": "株式会社", "302": "有限会社", "303": "合名会社", "304": "合資会社", "305": "合同会社", "399": "その他の設立登記法人", "401": "外国会社等", "499": "その他"};
function parse(xml){
  var count = +tag(xml, "count");
  if(!count) return null;
  var c = /<corporation>([\s\S]*?)<\/corporation>/.exec(xml);
  if(!c) return null;
  c = c[1];
  var post = tag(c, "postCode");
  return {
    corporateNumber: tag(c, "corporateNumber"),
    name: tag(c, "name"),
    furigana: tag(c, "furigana"),
    kind: KINDS[tag(c, "kind")] || "",
    prefecture: tag(c, "prefectureName"),
    city: tag(c, "cityName"),
    street: tag(c, "streetNumber"),
    postalCode: post.length === 7 ? post.slice(0, 3) + "-" + post.slice(3) : post,
    closed: !!tag(c, "closeDate"),
    closeDate: tag(c, "closeDate"),
    process: tag(c, "process")
  };
}

module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "no-store");
  if(req.method !== "POST"){ res.setHeader("Allow", "POST"); return res.status(405).json({error: "POST only"}); }
  var b = readBody(req);
  try{
    var a = b.auth || {};
    var me = await F.verifyMember(a.name, a.password);
    if(!me) return res.status(403).json({error: "認証に失敗しました"});
    var id = F.env("HOUJIN_APP_ID");
    if(b.action === "status") return res.status(200).json({configured: !!id});
    if(!id) return res.status(200).json({error: "notconfigured"});
    var n = String(b.number || "").normalize("NFKC").replace(/[^0-9]/g, "");
    if(!validNumber(n)) return res.status(200).json({error: "invalid"});
    var r = await fetch("https://api.houjin-bangou.nta.go.jp/4/num?id=" + encodeURIComponent(id) + "&number=" + n + "&type=12&history=0");
    var text = await r.text();
    if(!r.ok) return res.status(200).json({error: "upstream", status: r.status});
    var corp = parse(text);
    if(!corp) return res.status(200).json({error: "notfound"});
    return res.status(200).json({corp: corp});
  }catch(e){
    return res.status(200).json({error: "upstream"});
  }
};
module.exports._validNumber = validNumber;
module.exports._parse = parse;
