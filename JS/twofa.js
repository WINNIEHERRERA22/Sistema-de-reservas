"use strict";
/**
 * twofa.js — TOTP (RFC 6238) compatible con Google Authenticator, Authy, etc.
 * Por qué funciona: cliente y servidor comparten un secreto; ambos calculan
 * HMAC-SHA1(secreto, floor(tiempo/30s)) y lo reducen a 6 dígitos.
 */
const TwoFA = (() => {
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function b32enc(bytes) {
    let bits = 0, val = 0, out = "";
    for (const b of bytes) {
      val = (val << 8) | b; bits += 8;
      while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31];
    return out;
  }
  function b32dec(s) {
    let bits = 0, val = 0; const out = [];
    for (const c of s.replace(/=+$/, "").toUpperCase()) {
      const i = ALPHA.indexOf(c);
      if (i < 0) continue;
      val = (val << 5) | i; bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  async function hotp(keyBytes, counter) {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, Math.floor(counter / 2 ** 32));
    dv.setUint32(4, counter >>> 0);
    const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
    const o = h[19] & 15;
    const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(bin % 1000000).padStart(6, "0");
  }

  const newSecret = () => b32enc(Crypt.random(20));
  const uri = (user, secret) =>
    `otpauth://totp/RestoApp:${encodeURIComponent(user)}?secret=${secret}&issuer=RestoApp&algorithm=SHA1&digits=6&period=30`;

  // Devuelve el "paso" de 30 s que coincidió (o null). El paso sirve para impedir reutilizar un código.
  async function verify(secret, code, win = 1) {
    code = String(code || "").trim();
    if (!/^\d{6}$/.test(code)) return null;
    const key = b32dec(secret);
    const now = Math.floor(Date.now() / 30000);
    for (let i = -win; i <= win; i++) {
      if (Crypt.safeEqual(await hotp(key, now + i), code)) return now + i;
    }
    return null;
  }

  return { newSecret, uri, verify, hotp, b32enc, b32dec };
})();