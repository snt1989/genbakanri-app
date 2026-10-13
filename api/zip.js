// 郵便番号 → 住所の検索（ブラウザから直接 zipcloud に届かない場合の予備）。GET /api/zip?zipcode=0200866
// zipcloud が不調のときは、郵便番号の静的データ（madefor/postal-code-api）で補います。結果は zipcloud と同じ形で返します。
async function viaZipcloud(z){
  var r = await fetch("https://zipcloud.ibsnet.jp/api/search?zipcode=" + z);
  var j = await r.json();
  if(j && j.status === 200) return j;     // 該当なし(results:null)も正常応答として扱う
  throw new Error("zipcloud");
}
async function viaStatic(z){
  var r = await fetch("https://madefor.github.io/postal-code-api/api/v1/" + z.slice(0, 3) + "/" + z.slice(3) + ".json");
  if(r.status === 404) return {status: 200, results: null};
  var j = await r.json();
  var d = j && j.data && j.data[0] && j.data[0].ja;
  if(!d) return {status: 200, results: null};
  return {status: 200, results: [{zipcode: z, address1: d.prefecture, address2: d.address1 || "", address3: (d.address2 || "") + (d.address3 || "") + (d.address4 || "")}]};
}
module.exports = async function handler(req, res){
  var z = String((req.query && req.query.zipcode) || "").replace(/[^0-9]/g, "");
  if(z.length !== 7){ res.setHeader("Cache-Control", "no-store"); return res.status(400).json({status: 400, message: "zipcode"}); }
  var out = null;
  try{ out = await viaZipcloud(z); }catch(e){}
  if(!out || !out.results){
    try{ var alt = await viaStatic(z); if(alt && alt.results) out = alt; else if(!out) out = alt; }catch(e){}
  }
  if(!out){ res.setHeader("Cache-Control", "no-store"); return res.status(502).json({status: 502, message: "upstream"}); }
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.status(200).json(out);
};
