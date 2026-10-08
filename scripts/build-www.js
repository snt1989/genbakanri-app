// アプリ本体を www/ にコピーする（Capacitor が iOS/Android アプリに同梱する）。
// ネイティブ版は Firebase の設定を /api/config から取得できないため、
// 環境変数 APP_API_BASE（例: https://genbakanri-app.vercel.app）を指定すると
// そのURLの /api/config を参照するようにします。
var fs = require("fs"), path = require("path");
var root = path.join(__dirname, ".."), out = path.join(root, "www");
fs.rmSync(out, {recursive:true, force:true}); fs.mkdirSync(out, {recursive:true});
["index.html", "manifest.webmanifest", "sw.js"].forEach(function(f){ fs.copyFileSync(path.join(root,f), path.join(out,f)); });
fs.cpSync(path.join(root,"icons"), path.join(out,"icons"), {recursive:true});
var base = process.env.APP_API_BASE;
if(base){
  var h = fs.readFileSync(path.join(out,"index.html"),"utf8");
  var n = 0;
  ["config","freee","works","invite"].forEach(function(k){
    n += h.split('"/api/'+k).length - 1;
    h = h.split('"/api/'+k).join('"'+base.replace(/\/$/,"")+'/api/'+k);
  });
  fs.writeFileSync(path.join(out,"index.html"), h);
  console.log("api/config を "+base+" に向けました（"+n+"か所）");
}
console.log("www/ を作成しました");
