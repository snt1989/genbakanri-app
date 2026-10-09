// 郵便番号 → 住所の検索（ブラウザから直接 zipcloud に届かない場合の予備）。GET /api/zip?zipcode=0200866
module.exports = async function handler(req, res){
  res.setHeader("Cache-Control", "public, max-age=86400");
  var z = String((req.query && req.query.zipcode) || "").replace(/[^0-9]/g, "");
  if(z.length !== 7) return res.status(400).json({status: 400, message: "zipcode"});
  try{
    var r = await fetch("https://zipcloud.ibsnet.jp/api/search?zipcode=" + z);
    res.status(200).json(await r.json());
  }catch(e){ res.status(502).json({status: 502, message: "upstream"}); }
};
