"use strict";
/**
 * crypto.js — Utilidades criptográficas con Web Crypto API.
 *
 * Qué reemplaza: el "AES" del ejemplo era en realidad un XOR con clave fija
 * escrita en el código (cualquiera la lee y descifra). Aquí:
 *  - La clave maestra AES-GCM se genera en el navegador y se guarda como
 *    CryptoKey NO EXTRAÍBLE en IndexedDB: el JS puede usarla, pero nadie
 *    puede leer sus bytes ni copiarla a otro equipo.
 *  - AES-GCM cifra Y autentica: si alguien edita el texto cifrado en
 *    localStorage, el descifrado falla (detección de manipulación).
 *  - Contraseñas con PBKDF2-SHA256 + sal única (nunca texto plano).
 */
const Crypt = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PBKDF2_ITER = 310000;

  const toB64 = (buf) => {
    const b = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));
  const randomHex = (n = 16) => [...random(n)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Comparación en tiempo constante (evita filtrar información por tiempos).
  function safeEqual(a, b) {
    a = String(a); b = String(b);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  // ---- Almacén de la clave maestra (IndexedDB) ----
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open("resto-keys", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("k");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const idbGet = async (k) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction("k").objectStore("k").get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  };
  const idbSet = async (k, v) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction("k", "readwrite");
      t.objectStore("k").put(v, k);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  };

  let cachedKey = null;
  async function masterKey() {
    if (cachedKey) return cachedKey;
    let k = await idbGet("master");
    if (!k) {
      k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await idbSet("master", k);
    }
    cachedKey = k;
    return k;
  }

  // ---- Cifrado AES-GCM de objetos JSON ----
  async function encryptJSON(obj, key) {
    const iv = random(12); // IV nuevo y aleatorio en CADA cifrado (nunca reutilizar)
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
    return `v1.${toB64(iv)}.${toB64(ct)}`;
  }
  async function decryptJSON(str, key) {
    try {
      const [v, iv, ct] = String(str).split(".");
      if (v !== "v1") return null;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
      return JSON.parse(dec.decode(pt));
    } catch {
      return null; // manipulado, clave distinta o formato inválido
    }
  }

  // ---- Contraseñas: PBKDF2 + sal ----
  async function derive(password, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" }, base, 256);
    return toB64(bits);
  }
  async function hashPassword(password) {
    const salt = random(16);
    return { salt: toB64(salt), hash: await derive(String(password), salt) };
  }
  async function verifyPassword(password, saltB64, hashB64) {
    return safeEqual(await derive(String(password), fromB64(saltB64)), hashB64);
  }

  return { toB64, fromB64, random, randomHex, safeEqual, masterKey, encryptJSON, decryptJSON, hashPassword, verifyPassword };
})();