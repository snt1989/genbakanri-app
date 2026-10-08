// 最小のサービスワーカー：アプリ本体をキャッシュし、通信が不安定でも起動できるようにする。
// データ（Firebase等）はキャッシュせず常にネットワークを使う。
var CACHE = "genba-shell-v2";
var SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var req = e.request, url = new URL(req.url);
  if(req.method!=="GET" || url.origin!==self.location.origin || url.pathname.indexOf("/api/")===0) return;
  // ネットワーク優先（更新をすぐ反映）、失敗時のみキャッシュ
  e.respondWith(fetch(req).then(function(res){
    var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); return res;
  }).catch(function(){ return caches.match(req).then(function(m){ return m || caches.match("index.html"); }); }));
});

// プッシュ通知（チャットの新着など）
self.addEventListener("push", function(e){
  var d = {}; try{ d = e.data ? e.data.json() : {}; }catch(_){ d = {body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "現場管理", {
    body: d.body || "", tag: d.tag || "genba", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: {chatId: d.chatId || ""}, renotify: true
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var chatId = (e.notification.data && e.notification.data.chatId) || "";
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(function(cs){
    for(var i=0;i<cs.length;i++){ if("focus" in cs[i]){ cs[i].postMessage({type:"open-chat", chatId: chatId}); return cs[i].focus(); } }
    return self.clients.openWindow("./?chat=" + encodeURIComponent(chatId));
  }));
});
