// 依存パッケージなしの Web Push 実装（RFC 8030 / 8291 aes128gcm / RFC 8292 VAPID）。
var crypto = require("crypto");

function b64u(b){ return Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64u(s){ s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while(s.length % 4) s += "="; return Buffer.from(s, "base64"); }
function hmac(key, data){ return crypto.createHmac("sha256", key).update(data).digest(); }

function generateVAPIDKeys(){
  var e = crypto.createECDH("prime256v1"); e.generateKeys();
  return {publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey())};
}

function vapidHeader(endpoint, pub, priv, subject){
  var pk = unb64u(pub);
  var key = crypto.createPrivateKey({key: {kty: "EC", crv: "P-256", d: priv, x: b64u(pk.slice(1, 33)), y: b64u(pk.slice(33, 65))}, format: "jwk"});
  var aud = new URL(endpoint).origin;
  var head = b64u(JSON.stringify({typ: "JWT", alg: "ES256"}));
  var claim = b64u(JSON.stringify({aud: aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject}));
  var sig = crypto.sign("sha256", Buffer.from(head + "." + claim), {key: key, dsaEncoding: "ieee-p1363"});
  return "vapid t=" + head + "." + claim + "." + b64u(sig) + ", k=" + pub;
}

function encrypt(sub, payload){
  var uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  var as = crypto.createECDH("prime256v1"); as.generateKeys();
  var asPub = as.getPublicKey();
  var secret = as.computeSecret(uaPub);
  var prkKey = hmac(auth, secret);
  var ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub, Buffer.from([1])]));
  var salt = crypto.randomBytes(16);
  var prk = hmac(salt, ikm);
  var cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).slice(0, 16);
  var nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).slice(0, 12);
  var c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  var ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  var rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}

async function send(sub, payload, vapid, ttl){
  var body = encrypt(sub, payload);
  var r = await fetch(sub.endpoint, {method: "POST", headers: {
    "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "Content-Length": String(body.length),
    TTL: String(ttl || 3600), Urgency: "high",
    Authorization: vapidHeader(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject)
  }, body: body});
  if(!r.ok){ var e = new Error("push " + r.status); e.statusCode = r.status; throw e; }
  return r.status;
}

module.exports = {generateVAPIDKeys: generateVAPIDKeys, send: send, encrypt: encrypt, vapidHeader: vapidHeader, b64u: b64u, unb64u: unb64u};
