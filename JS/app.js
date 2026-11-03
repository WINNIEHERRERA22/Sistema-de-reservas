"use strict";
/**
 * app.js — Controlador principal: arranque, login en dos pasos, navegación por rol,
 * caducidad de sesión por inactividad y Google Sign-In.
 */
const App = (() => {
  const $ = (id) => document.getElementById(id);
  const MENU = [["dashboard", "Panel", "▦"], ["mesas", "Mesas", "◫"], ["reservas", "Reservas", "◷"], ["pedidos", "Pedidos", "✎"],
    ["cocina", "Cocina", "♨"], ["despachos", "Despachos", "➜"], ["inventario", "Inventario", "▤"], ["usuarios", "Usuarios y bitácora", "☺"], ["seguridad", "Mi seguridad", "🔒"]];
  const TITLES = { dashboard: "Panel", mesas: "Mesas", reservas: "Reservas", pedidos: "Pedidos", cocina: "Cocina",
    despachos: "Despachos", inventario: "Inventario", usuarios: "Usuarios y bitácora", seguridad: "Mi seguridad" };
  let view = "dashboard";

  const loginError = (msg) => { $("loginError").textContent = msg || ""; };

  function showLogin() {
    $("appShell").hidden = true; $("loginScreen").hidden = false;
    $("loginForm").hidden = false; $("totpForm").hidden = true;
    $("loginForm").reset(); $("totpForm").reset(); loginError("");
  }

  function buildMenu() {
    const nav = $("menu"); nav.replaceChildren();
    for (const [id, label, icon] of MENU) {
      if (!Auth.can(id)) continue; // el menú solo muestra lo que el rol puede usar
      nav.append(UI.h("button", { class: "nav-item", "data-view": id, onclick: () => go(id) }, `${icon}  ${label}`));
    }
  }

  async function go(target) {
    const c = Auth.current();
    if (!c) return showLogin();
    if (!Auth.can(target)) { UI.toast("No tienes acceso a esa vista", false); target = "dashboard"; }
    view = target;
    $("viewTitle").textContent = TITLES[view];
    $("userName").textContent = c.username; $("roleBadge").textContent = c.rol;
    $("banner").hidden = !c.mustChange;
    $("banner").textContent = c.mustChange ? "Por seguridad, cambia tu contraseña inicial antes de continuar." : "";
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    try { $("content").replaceChildren(await Views[view]()); }
    catch (e) { console.error(e); UI.toast("No se pudo cargar la vista", false); }
    $("sidebar").classList.remove("open");
  }

  const refresh = () => go(view);

  async function enter() {
    const c = Auth.current();
    if (!c) return showLogin();
    $("loginScreen").hidden = true; $("appShell").hidden = false;
    buildMenu();
    await go(c.mustChange ? "seguridad" : "dashboard");
  }

  async function logout(motivo) {
    await Auth.logout(motivo);
    GoogleAuth.logout();
    showLogin();
  }

  function wireLogin() {
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault(); loginError("");
      const btn = e.submitter; btn.disabled = true;
      try {
        const fd = new FormData(e.target);
        const r = await Auth.step1(fd.get("username"), fd.get("password"));
        e.target.reset();
        if (!r.ok) return loginError(r.error);
        if (r.needs2fa) { $("loginForm").hidden = true; $("totpForm").hidden = false; $("totpForm").elements.code.focus(); return; }
        await enter();
      } finally { btn.disabled = false; }
    });
    $("totpForm").addEventListener("submit", async (e) => {
      e.preventDefault(); loginError("");
      const btn = e.submitter; btn.disabled = true;
      try {
        const r = await Auth.step2(new FormData(e.target).get("code"));
        e.target.reset();
        if (!r.ok) { loginError(r.error); if (r.restart) showLogin(); return; }
        await enter();
      } finally { btn.disabled = false; }
    });
    $("totpBack").addEventListener("click", showLogin);
    $("logoutBtn").addEventListener("click", () => logout("logout"));
    $("menuToggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  }

  function wireGoogle() {
    if (!GoogleAuth.isConfigured()) {
      $("googleBlock").hidden = true; // sin CLIENT_ID real no se muestra el botón
      return;
    }
    GoogleAuth.init({
      buttonContainerId: "googleSignInDiv",
      onSuccess: async (g) => {
        const r = await Auth.loginGoogle(g);
        if (!r.ok) return loginError(r.error);
        await enter();
      },
      onError: (motivo) => loginError(motivo),
    }).catch(() => { $("googleBlock").hidden = true; });
  }

  // Caducidad por inactividad: cualquier interacción renueva; el reloj revisa cada 15 s.
  function watchIdle() {
    ["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => Auth.touch(), { passive: true }));
    setInterval(() => {
      if (!$("appShell").hidden && !Auth.current()) { UI.toast("Tu sesión expiró por inactividad", false); showLogin(); }
    }, 15000);
  }

  async function boot() {
    if (!window.crypto || !crypto.subtle || !window.indexedDB) {
      document.body.textContent = "Este navegador o contexto no soporta cifrado seguro. Abre la app por https:// o http://localhost.";
      return;
    }
    try {
      Store.onTamper = (n) => UI.toast(`Se detectó una modificación indebida en «${n}». El dato alterado se apartó.`, false);
      await Auth.init();
      await Data.init();
      wireLogin(); wireGoogle(); watchIdle();
      if (await Auth.restore()) await enter(); else showLogin();
    } catch (e) {
      console.error(e);
      document.body.textContent = "No se pudo iniciar la aplicación. Revisa la consola del navegador.";
    }
  }

  return { boot, refresh };
})();

App.boot();