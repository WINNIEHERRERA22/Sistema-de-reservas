"use strict";
/**
 * storage.js — Persistencia cifrada + validación de esquema + auditoría.
 * Regla: NADA se guarda en localStorage sin pasar por Store.save(),
 * y toda escritura valida el dato ANTES de cifrarlo.
 */
class AppError extends Error {} // errores "seguros" para mostrar al usuario

// ---------- Validadores (listas permitidas, no listas negras) ----------
const V = (() => {
  const TEXT = /^[\p{L}\p{N} .,\-_:()#@]+$/u;
  const fail = (m) => { throw new AppError(m); };
  return {
    text(v, label, { min = 1, max = 80 } = {}) {
      if (typeof v !== "string") fail(`${label}: valor inválido`);
      const s = v.normalize("NFC").trim();
      if (s.length < min || s.length > max) fail(`${label}: debe tener entre ${min} y ${max} caracteres`);
      if (!TEXT.test(s)) fail(`${label}: contiene caracteres no permitidos`);
      return s;
    },
    int(v, label, min, max) {
      if (!Number.isInteger(v) || v < min || v > max) fail(`${label}: debe ser un entero entre ${min} y ${max}`);
      return v;
    },
    num(v, label, min, max) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(`${label}: debe ser un número entre ${min} y ${max}`);
      return Math.round(v * 1000) / 1000;
    },
    oneOf(v, list, label) {
      if (!list.includes(v)) fail(`${label}: valor no permitido`);
      return v;
    },
    date(v) {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail("Fecha inválida");
      const [y, m, d] = v.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) fail("Fecha inválida");
      return v;
    },
    time(v) {
      if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail("Hora inválida");
      return v;
    },
    email(v) {
      if (typeof v !== "string" || v.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v)) fail("Correo inválido");
      return v.toLowerCase();
    },
    username(v) {
      if (typeof v !== "string" || !/^[a-z0-9_]{3,20}$/.test(v)) fail("Usuario: 3–20 caracteres, solo minúsculas, números y _");
      return v;
    },
  };
})();

// ---------- Store: localStorage cifrado ----------
const Store = (() => {
  const P = "resto:";
  const api = {
    onTamper: null,
    async load(name, fallback) {
      const raw = localStorage.getItem(P + name);
      if (raw === null) return fallback();
      const val = await Crypt.decryptJSON(raw, await Crypt.masterKey());
      if (val === null) {
        // Dato alterado (o clave perdida): se aparta como evidencia, no se borra en silencio.
        localStorage.setItem(`${P}${name}.corrupt.${Date.now()}`, raw);
        localStorage.removeItem(P + name);
        if (api.onTamper) api.onTamper(name);
        return fallback();
      }
      return val;
    },
    async save(name, value, validate) {
      if (validate) validate(value); // valida ANTES de persistir
      localStorage.setItem(P + name, await Crypt.encryptJSON(value, await Crypt.masterKey()));
    },
  };
  return api;
})();

// ---------- Auditoría (bitácora cifrada, serializada para evitar carreras) ----------
const Audit = (() => {
  const MAX = 500;
  let chain = Promise.resolve();
  const api = {
    actor: () => "-",
    log(evento, detalle = "") {
      const entry = { t: Date.now(), u: api.actor(), e: String(evento).slice(0, 40), d: String(detalle).slice(0, 160) };
      chain = chain.then(async () => {
        const list = await Store.load("audit", () => []);
        list.push(entry);
        while (list.length > MAX) list.shift();
        await Store.save("audit", list);
      }).catch((e) => console.warn("audit:", e));
      return chain;
    },
    list: () => Store.load("audit", () => []),
  };
  return api;
})();