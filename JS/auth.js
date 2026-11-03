"use strict";
/**
 * auth.js — Login, 2FA, sesión cifrada y permisos por rol.
 *
 * Flujo:  usuario+contraseña (PBKDF2)  →  código TOTP (si tiene 2FA)  →  sesión cifrada.
 * Alterno: Google Identity Services  →  correo verificado en lista autorizada  →  sesión.
 *
 * LÍMITE HONESTO: todo corre en el navegador, así que el bloqueo por intentos
 * y los roles son una barrera, no una garantía. La validación definitiva
 * debe vivir en un backend (ver README, fase siguiente).
 */
const ROLES = ["administrador", "mesero", "cocina", "despacho"];
const VIEW_ROLES = {
  dashboard: ROLES,
  mesas: ["administrador", "mesero"],
  reservas: ["administrador", "mesero"],
  pedidos: ["administrador", "mesero"],
  cocina: ["administrador", "cocina"],
  despachos: ["administrador", "mesero", "despacho"],
  inventario: ["administrador"],
  usuarios: ["administrador"],
  seguridad: ROLES,
};

const Auth = (() => {
  const MAX_FAILS = 5, LOCK_MS = 5 * 60e3, IDLE_MS = 15 * 60e3, ABS_MS = 8 * 3600e3, PENDING_MS = 2 * 60e3;
  const SKEY = "resto:session";
  let users = [], session = null, pending = null, setup = null, lastPersist = 0;

  const GENERIC = "Usuario o contraseña incorrectos";
  const validateUsers = (list) => {
    if (!Array.isArray(list) || !list.length) throw new AppError("Usuarios inválidos");
    list.forEach((u) => {
      V.username(u.username); V.oneOf(u.rol, ROLES, "rol");
      if (typeof u.hash !== "string" || typeof u.salt !== "string") throw new AppError("Credenciales inválidas");
    });
  };
  const persist = () => Store.save("users", users, validateUsers);
  const findUser = (name) => users.find((u) => u.username === name);
  const strong = (pw) => typeof pw === "string" && pw.length >= 10 && pw.length <= 128 &&
    /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
  const POLICY = "La contraseña debe tener mínimo 10 caracteres, con mayúscula, minúscula y número";

  async function newUser(username, password, rol, extra = {}) {
    const { salt, hash } = await Crypt.hashPassword(password);
    return { username, rol, salt, hash, active: true, failed: 0, lockedUntil: 0, googleEmail: null, totp: null, mustChange: false, ...extra };
  }

  async function seed() {
    // Usuarios demo del enunciado. Contraseñas con hash; obligan a cambiarlas en el primer ingreso.
    const demo = [["admin", "admin123", "administrador"], ["mesero", "mesero123", "mesero"],
      ["cocina", "cocina123", "cocina"], ["despacho", "despacho123", "despacho"]];
    const out = [];
    for (const [u, p, r] of demo) out.push(await newUser(u, p, r, { mustChange: true }));
    return out;
  }

  async function init() {
    users = await Store.load("users", () => null);
    if (!users) { users = await seed(); await persist(); }
    Audit.actor = () => (session ? session.u : "-");
  }

  // ---------- Sesión (cifrada en sessionStorage, con caducidad) ----------
  async function saveSession() {
    sessionStorage.setItem(SKEY, await Crypt.encryptJSON(session, await Crypt.masterKey()));
  }
  function expire() { session = null; sessionStorage.removeItem(SKEY); }
  function current() {
    if (!session) return null;
    const now = Date.now();
    const u = findUser(session.u);
    if (now - session.last > IDLE_MS || now - session.iat > ABS_MS || !u || !u.active || u.rol !== session.rol) {
      expire(); return null;
    }
    return { username: u.username, rol: u.rol, mustChange: !!u.mustChange };
  }
  async function startSession(u, via) {
    const now = Date.now();
    session = { u: u.username, rol: u.rol, iat: now, last: now, sid: Crypt.randomHex(16) };
    await saveSession();
    await Audit.log("login_ok", `via ${via}`);
  }
  async function restore() {
    const raw = sessionStorage.getItem(SKEY);
    if (!raw) return null;
    const s = await Crypt.decryptJSON(raw, await Crypt.masterKey());
    if (!s) { sessionStorage.removeItem(SKEY); return null; }
    session = s;
    const c = current(); // aplica las mismas reglas de caducidad y rol
    return c;
  }
  function touch() {
    if (!session) return;
    session.last = Date.now();
    if (session.last - lastPersist > 30e3) { lastPersist = session.last; saveSession(); }
  }
  async function logout(motivo = "logout") {
    if (session) await Audit.log(motivo, "");
    expire(); pending = null; setup = null;
  }

  // ---------- Permisos ----------
  const can = (view) => { const c = current(); return !!c && !!VIEW_ROLES[view] && VIEW_ROLES[view].includes(c.rol); };
  function assert(roles) {
    const c = current();
    if (!c || !roles.includes(c.rol)) throw new AppError("No tienes permiso para esta acción");
    return c;
  }

  // ---------- Login paso 1: contraseña ----------
  async function registerFail(u) {
    u.failed += 1;
    if (u.failed >= MAX_FAILS) { u.lockedUntil = Date.now() + LOCK_MS; u.failed = 0; await Audit.log("cuenta_bloqueada", u.username); }
    await persist();
  }
  const lockMsg = (u) => `Cuenta bloqueada. Intenta de nuevo en ${Math.ceil((u.lockedUntil - Date.now()) / 60000)} min`;

  async function step1(username, password) {
    username = String(username || "").trim().toLowerCase();
    const u = findUser(username);
    if (!u || !u.active) {
      await Crypt.hashPassword(String(password || "x")); // igualar tiempos: no revelar si el usuario existe
      await Audit.log("login_fallido", username.slice(0, 20));
      return { ok: false, error: GENERIC };
    }
    if (u.lockedUntil > Date.now()) return { ok: false, error: lockMsg(u) };
    if (!(await Crypt.verifyPassword(password, u.salt, u.hash))) {
      await registerFail(u);
      await Audit.log("login_fallido", username);
      return { ok: false, error: u.lockedUntil > Date.now() ? lockMsg(u) : GENERIC };
    }
    if (u.totp && u.totp.enabled) {
      pending = { username: u.username, exp: Date.now() + PENDING_MS };
      return { ok: true, needs2fa: true };
    }
    u.failed = 0; await persist();
    await startSession(u, "contraseña");
    return { ok: true };
  }

  // ---------- Login paso 2: código TOTP ----------
  async function step2(code) {
    if (!pending || pending.exp < Date.now()) { pending = null; return { ok: false, error: "El paso anterior expiró. Vuelve a iniciar sesión", restart: true }; }
    const u = findUser(pending.username);
    if (u.lockedUntil > Date.now()) return { ok: false, error: lockMsg(u) };
    const step = await TwoFA.verify(u.totp.secret, code);
    if (step === null || step <= (u.totp.lastStep || 0)) { // lastStep: un código no se reutiliza
      await registerFail(u);
      await Audit.log("2fa_fallido", u.username);
      return { ok: false, error: "Código incorrecto o ya utilizado" };
    }
    u.totp.lastStep = step; u.failed = 0; await persist();
    pending = null;
    await startSession(u, "contraseña+2FA");
    return { ok: true };
  }

  // ---------- Login con Google (solo correos autorizados por el administrador) ----------
  async function loginGoogle(g) {
    const email = String(g && g.email || "").toLowerCase();
    const u = users.find((x) => x.googleEmail === email && x.active);
    if (!g || g.emailVerified !== true || !u) {
      await Audit.log("google_rechazado", email.slice(0, 40));
      return { ok: false, error: "Esta cuenta de Google no está autorizada" };
    }
    if (u.lockedUntil > Date.now()) return { ok: false, error: lockMsg(u) };
    await startSession(u, "google");
    return { ok: true };
  }

  // ---------- Autoservicio: contraseña y 2FA ----------
  async function changePassword(oldPw, newPw) {
    const c = assert(ROLES); const u = findUser(c.username);
    if (!(await Crypt.verifyPassword(oldPw, u.salt, u.hash))) throw new AppError("La contraseña actual no es correcta");
    if (!strong(newPw)) throw new AppError(POLICY);
    if (newPw === oldPw) throw new AppError("La nueva contraseña debe ser distinta");
    Object.assign(u, await Crypt.hashPassword(newPw), { mustChange: false });
    await persist(); await Audit.log("password_cambiada", "");
  }
  function begin2FA() {
    const c = assert(ROLES);
    setup = { user: c.username, secret: TwoFA.newSecret() };
    return { secret: setup.secret, uri: TwoFA.uri(c.username, setup.secret) };
  }
  async function confirm2FA(code) {
    const c = assert(ROLES);
    if (!setup || setup.user !== c.username) throw new AppError("Inicia la configuración del 2FA primero");
    const step = await TwoFA.verify(setup.secret, code);
    if (step === null) throw new AppError("Código incorrecto");
    findUser(c.username).totp = { enabled: true, secret: setup.secret, lastStep: step };
    setup = null; await persist(); await Audit.log("2fa_activado", "");
  }
  async function disable2FA(password) {
    const c = assert(ROLES); const u = findUser(c.username);
    if (!(await Crypt.verifyPassword(password, u.salt, u.hash))) throw new AppError("Contraseña incorrecta");
    u.totp = null; await persist(); await Audit.log("2fa_desactivado", "");
  }
  const my2FA = () => { const c = assert(ROLES); const u = findUser(c.username); return !!(u.totp && u.totp.enabled); };

  // ---------- Administración de usuarios (solo administrador) ----------
  const listUsers = () => { assert(["administrador"]); return users.map((u) => ({
    username: u.username, rol: u.rol, active: u.active, googleEmail: u.googleEmail, has2FA: !!(u.totp && u.totp.enabled) })); };
  async function createUser({ username, password, rol }) {
    assert(["administrador"]);
    V.username(username); V.oneOf(rol, ROLES, "rol");
    if (findUser(username)) throw new AppError("Ese usuario ya existe");
    if (!strong(password)) throw new AppError(POLICY);
    users.push(await newUser(username, password, rol, { mustChange: true }));
    await persist(); await Audit.log("usuario_creado", `${username} (${rol})`);
  }
  async function setGoogleEmail(username, email) {
    assert(["administrador"]); const u = findUser(username);
    if (!u) throw new AppError("Usuario no existe");
    const clean = email ? V.email(email) : null;
    if (clean && users.some((x) => x.googleEmail === clean && x !== u)) throw new AppError("Ese correo ya está asignado");
    u.googleEmail = clean; await persist(); await Audit.log("google_asignado", username);
  }
  async function setActive(username, active) {
    const c = assert(["administrador"]); const u = findUser(username);
    if (!u) throw new AppError("Usuario no existe");
    if (u.username === c.username) throw new AppError("No puedes desactivarte a ti mismo");
    u.active = !!active; await persist(); await Audit.log(active ? "usuario_activado" : "usuario_desactivado", username);
  }
  async function reset2FA(username) {
    assert(["administrador"]); const u = findUser(username);
    if (!u) throw new AppError("Usuario no existe");
    u.totp = null; await persist(); await Audit.log("2fa_reseteado", username);
  }

  return { init, restore, current, touch, logout, can, assert, step1, step2, loginGoogle,
    changePassword, begin2FA, confirm2FA, disable2FA, my2FA, listUsers, createUser, setGoogleEmail, setActive, reset2FA };
})();