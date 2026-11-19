// 公開前チェック：構文エラーや、まとめ作業の消し残し（<<<<<<< など）があれば公開を止める。
// Vercel の buildCommand から実行される（失敗すると新しい版は公開されず、前の版のまま動き続ける）。
var fs = require("fs"), path = require("path"), cp = require("child_process"), os = require("os");
var root = path.join(__dirname, ".."), bad = [];
function fail(m){ bad.push(m); console.error("NG  " + m); }
function nodeCheck(file, label, asModule){
  var r = cp.spawnSync(process.execPath, ["--check", file], {encoding: "utf8"});
  if(r.status !== 0) fail(label + " に構文エラーがあります\n" + String(r.stderr || "").split("\n").slice(0, 6).join("\n"));
  else console.log("OK  " + label);
}
function conflict(file, text){ if(/^(<{7} |={7}$|>{7} )/m.test(text)) fail(file + " に、まとめ作業の消し残し（<<<<<<< / >>>>>>>）があります"); }
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chk-"));
fs.readdirSync(root).filter(function(f){ return /\.html$/.test(f); }).forEach(function(f){
  var html = fs.readFileSync(path.join(root, f), "utf8");
  conflict(f, html);
  var re = /<script([^>]*)>([\s\S]*?)<\/script>/g, m, i = 0;
  while((m = re.exec(html))){
    i++;
    if(/\bsrc=/.test(m[1]) || !m[2].trim()) continue;
    if(/type=["']?(?!module|text\/javascript)[^"'\s>]+/.test(m[1]) && !/type=["']?module/.test(m[1])) continue;   // JSON などは対象外
    var isMod = /type=["']?module/.test(m[1]);
    var out = path.join(tmp, f.replace(/\W/g, "_") + "_" + i + (isMod ? ".mjs" : ".js"));
    fs.writeFileSync(out, m[2]);
    nodeCheck(out, f + " の " + i + " 番目のスクリプト");
  }
  if(f === "index.html" && i < 4) fail("index.html のスクリプトが足りません");
});
["sw.js"].concat(fs.readdirSync(path.join(root, "api")).filter(function(f){ return /\.js$/.test(f); }).map(function(f){ return "api/" + f; })).forEach(function(f){
  conflict(f, fs.readFileSync(path.join(root, f), "utf8"));
  nodeCheck(path.join(root, f), f);
});
try{ JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8")); JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8")); console.log("OK  設定ファイル"); }catch(e){ fail("vercel.json / manifest.webmanifest が壊れています: " + e.message); }
if(bad.length){ console.error("\n公開前チェックで " + bad.length + " 件の問題が見つかりました。公開を中止します。"); process.exit(1); }
console.log("\n公開前チェック：問題なし");
