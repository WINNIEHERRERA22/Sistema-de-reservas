"use strict";
/**
 * modules.js — Lógica de negocio (Data/Ops) y vistas (Views).
 * Seguridad aplicada aquí:
 *  - Toda mutación pasa por Data.mutate(): verifica rol → trabaja sobre una copia →
 *    valida esquema → cifra y guarda → audita. Si algo falla, el estado NO cambia.
 *  - Las vistas construyen el DOM con textContent (UI.h). Nunca innerHTML con datos.
 */

// ============================ Utilidades ============================
const pad2 = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const mins = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const nextId = (arr) => arr.reduce((m, x) => Math.max(m, x.id), 0) + 1;

// ============================ Datos ============================
const defaultData = () => ({
  mesas: [2, 2, 4, 4, 4, 6, 6, 8].map((cap, i) => ({ id: i + 1, capacidad: cap, estado: "disponible" })),
  insumos: [
    { id: 1, nombre: "Pescado fresco", unidad: "kg", stock: 8, minimo: 2 },
    { id: 2, nombre: "Limón", unidad: "unid", stock: 60, minimo: 15 },
    { id: 3, nombre: "Carne de res", unidad: "kg", stock: 12, minimo: 3 },
    { id: 4, nombre: "Arroz", unidad: "kg", stock: 15, minimo: 4 },
    { id: 5, nombre: "Pollo", unidad: "kg", stock: 10, minimo: 3 },
    { id: 6, nombre: "Pasta", unidad: "kg", stock: 6, minimo: 2 },
    { id: 7, nombre: "Verduras", unidad: "kg", stock: 9, minimo: 3 },
    { id: 8, nombre: "Mariscos", unidad: "kg", stock: 5, minimo: 2 },
    { id: 9, nombre: "Coco", unidad: "unid", stock: 20, minimo: 5 },
  ],
  platos: [
    { id: 1, nombre: "Ceviche", precio: 32000, receta: [{ insumoId: 1, cantidad: 0.2 }, { insumoId: 2, cantidad: 3 }] },
    { id: 2, nombre: "Lomo saltado", precio: 38000, receta: [{ insumoId: 3, cantidad: 0.25 }, { insumoId: 4, cantidad: 0.15 }, { insumoId: 7, cantidad: 0.1 }] },
    { id: 3, nombre: "Arroz con pollo", precio: 28000, receta: [{ insumoId: 5, cantidad: 0.25 }, { insumoId: 4, cantidad: 0.2 }] },
    { id: 4, nombre: "Pasta al pesto", precio: 27000, receta: [{ insumoId: 6, cantidad: 0.2 }, { insumoId: 7, cantidad: 0.05 }] },
    { id: 5, nombre: "Ensalada mediterránea", precio: 21000, receta: [{ insumoId: 7, cantidad: 0.25 }] },
    { id: 6, nombre: "Sopa de mariscos", precio: 36000, receta: [{ insumoId: 8, cantidad: 0.3 }, { insumoId: 7, cantidad: 0.1 }] },
    { id: 7, nombre: "Parrillada", precio: 58000, receta: [{ insumoId: 3, cantidad: 0.4 }, { insumoId: 5, cantidad: 0.2 }] },
    { id: 8, nombre: "Flan de coco", precio: 16000, receta: [{ insumoId: 9, cantidad: 1 }] },
  ],
  reservas: [], pedidos: [], despachos: [],
});

const Data = (() => {
  const E_MESA = ["disponible", "reservada", "ocupada"];
  const E_ITEM = ["pendiente", "preparando", "listo"];
  const E_DESP = ["pendiente", "en_ruta", "entregado"];
  let state = null;
  let queue = Promise.resolve();

  function validate(d) {
    for (const k of ["mesas", "platos", "insumos", "reservas", "pedidos", "despachos"])
      if (!Array.isArray(d[k])) throw new AppError("Datos corruptos: " + k);
    d.mesas.forEach((m) => { V.oneOf(m.estado, E_MESA, "estado de mesa"); V.int(m.capacidad, "capacidad", 1, 50); });
    d.insumos.forEach((i) => { V.text(i.nombre, "insumo"); V.num(i.stock, "stock", 0, 1e6); V.num(i.minimo, "mínimo", 0, 1e6); });
    d.pedidos.forEach((p) => p.items.forEach((it) => V.oneOf(it.estado, E_ITEM, "estado del plato")));
    d.despachos.forEach((x) => V.oneOf(x.estado, E_DESP, "estado del despacho"));
  }

  async function init() {
    state = await Store.load("data", defaultData);
    try { validate(state); } catch { state = defaultData(); }
  }

  // Serializa las operaciones (evita que dos clics pisen los datos) y es atómica.
  function mutate(roles, evento, fn) {
    const run = async () => {
      const c = Auth.assert(roles);
      const draft = structuredClone(state);
      const detalle = fn(draft, c);
      await Store.save("data", draft, validate);
      state = draft;
      Audit.log(evento, detalle || "");
      return detalle;
    };
    const p = queue.then(run);
    queue = p.catch(() => {});
    return p;
  }
  return { init, get: () => state, mutate };
})();

// ============================ Operaciones de negocio ============================
const recalc = (d, mesaId) => {
  const m = d.mesas.find((x) => x.id === mesaId);
  if (!m) return;
  if (d.pedidos.some((p) => p.mesaId === mesaId && p.estado === "abierto")) m.estado = "ocupada";
  else if (d.reservas.some((r) => r.mesaId === mesaId && r.estado === "activa" && r.fecha === todayStr())) m.estado = "reservada";
  else m.estado = "disponible";
};
const MESERO = ["administrador", "mesero"], ADMIN = ["administrador"];

const Ops = {
  crearReserva: (f) => Data.mutate(MESERO, "reserva_crear", (d, c) => {
    const mesaId = V.int(f.mesaId, "Mesa", 1, 999);
    const mesa = d.mesas.find((m) => m.id === mesaId);
    if (!mesa) throw new AppError("La mesa no existe");
    const fecha = V.date(f.fecha);
    if (fecha < todayStr()) throw new AppError("La fecha no puede ser pasada");
    const hora = V.time(f.hora);
    const personas = V.int(f.personas, "Personas", 1, 20);
    if (personas > mesa.capacidad) throw new AppError(`La mesa ${mesaId} admite máximo ${mesa.capacidad} personas`);
    const cliente = V.text(f.cliente, "Cliente", { max: 60 });
    const choque = d.reservas.some((r) => r.estado === "activa" && r.mesaId === mesaId && r.fecha === fecha &&
      Math.abs(mins(r.hora) - mins(hora)) < 120);
    if (choque) throw new AppError("Esa mesa ya tiene una reserva en un rango de 2 horas");
    const id = nextId(d.reservas);
    d.reservas.push({ id, mesaId, fecha, hora, personas, cliente, estado: "activa", por: c.username });
    recalc(d, mesaId);
    return `reserva ${id} mesa ${mesaId}`;
  }),

  cancelarReserva: (id) => Data.mutate(MESERO, "reserva_cancelar", (d) => {
    const r = d.reservas.find((x) => x.id === V.int(id, "Reserva", 1, 1e6) && x.estado === "activa");
    if (!r) throw new AppError("Reserva no encontrada");
    r.estado = "cancelada"; recalc(d, r.mesaId);
    return `reserva ${r.id}`;
  }),

  crearPedido: (f) => Data.mutate(MESERO, "pedido_crear", (d, c) => {
    const mesaId = V.int(f.mesaId, "Mesa", 1, 999);
    if (!d.mesas.some((m) => m.id === mesaId)) throw new AppError("La mesa no existe");
    if (!Array.isArray(f.items) || f.items.length < 1 || f.items.length > 20) throw new AppError("Agrega entre 1 y 20 platos");
    const merged = new Map();
    for (const it of f.items) {
      const pid = V.int(it.platoId, "Plato", 1, 999);
      merged.set(pid, (merged.get(pid) || 0) + V.int(it.cantidad, "Cantidad", 1, 20));
    }
    const need = new Map(), items = [];
    for (const [pid, q] of merged) {
      const pl = d.platos.find((p) => p.id === pid);
      if (!pl) throw new AppError("El plato no existe");
      if (q > 20) throw new AppError("Máximo 20 unidades por plato");
      pl.receta.forEach((r) => need.set(r.insumoId, (need.get(r.insumoId) || 0) + r.cantidad * q));
      items.push({ platoId: pid, nombre: pl.nombre, precio: pl.precio, cantidad: q, estado: "pendiente", despachado: false });
    }
    // Inventario: se descuenta al confirmar el pedido (todo o nada, por la copia de trabajo).
    for (const [iid, qty] of need) {
      const ins = d.insumos.find((i) => i.id === iid);
      if (!ins || ins.stock < qty - 1e-9) throw new AppError(`Stock insuficiente de ${ins ? ins.nombre : "un insumo"}`);
      ins.stock = Math.round((ins.stock - qty) * 1000) / 1000;
    }
    const id = nextId(d.pedidos);
    d.pedidos.push({ id, mesaId, estado: "abierto", ts: Date.now(), por: c.username, items });
    recalc(d, mesaId);
    return `pedido ${id} mesa ${mesaId}`;
  }),

  // Cocina: pendiente → preparando → listo (sin saltos ni retrocesos)
  avanzarPlato: (pedidoId, idx) => Data.mutate(["administrador", "cocina"], "plato_estado", (d) => {
    const p = d.pedidos.find((x) => x.id === pedidoId && x.estado === "abierto");
    const it = p && p.items[idx];
    if (!it) throw new AppError("Plato no encontrado");
    const sig = { pendiente: "preparando", preparando: "listo" }[it.estado];
    if (!sig) throw new AppError("Este plato ya está listo");
    it.estado = sig;
    return `pedido ${p.id} ${it.nombre} → ${sig}`;
  }),

  crearDespacho: (pedidoId) => Data.mutate(["administrador", "mesero", "despacho"], "despacho_crear", (d) => {
    const p = d.pedidos.find((x) => x.id === pedidoId && x.estado === "abierto");
    if (!p) throw new AppError("Pedido no encontrado");
    const listos = p.items.filter((it) => it.estado === "listo" && !it.despachado);
    if (!listos.length) throw new AppError("No hay platos listos por despachar");
    listos.forEach((it) => { it.despachado = true; });
    const id = nextId(d.despachos);
    d.despachos.push({ id, pedidoId: p.id, mesaId: p.mesaId, platos: listos.map((it) => `${it.cantidad}× ${it.nombre}`), estado: "pendiente" });
    return `despacho ${id} pedido ${p.id}`;
  }),

  avanzarDespacho: (id) => Data.mutate(["administrador", "mesero", "despacho"], "despacho_estado", (d) => {
    const x = d.despachos.find((z) => z.id === id);
    if (!x) throw new AppError("Despacho no encontrado");
    const sig = { pendiente: "en_ruta", en_ruta: "entregado" }[x.estado];
    if (!sig) throw new AppError("Este despacho ya fue entregado");
    x.estado = sig;
    return `despacho ${x.id} → ${sig}`;
  }),

  cerrarPedido: (id) => Data.mutate(MESERO, "pedido_cerrar", (d) => {
    const p = d.pedidos.find((x) => x.id === id && x.estado === "abierto");
    if (!p) throw new AppError("Pedido no encontrado");
    const todoEntregado = p.items.every((it) => it.despachado) &&
      d.despachos.filter((x) => x.pedidoId === p.id).every((x) => x.estado === "entregado");
    if (!todoEntregado) throw new AppError("Aún hay platos sin despachar o sin entregar");
    p.estado = "cerrado"; recalc(d, p.mesaId);
    return `pedido ${p.id}`;
  }),

  // ---- Inventario (solo administrador) ----
  crearInsumo: (f) => Data.mutate(ADMIN, "insumo_crear", (d) => {
    const nombre = V.text(f.nombre, "Nombre", { max: 40 });
    if (d.insumos.some((i) => i.nombre.toLowerCase() === nombre.toLowerCase())) throw new AppError("Ese insumo ya existe");
    d.insumos.push({ id: nextId(d.insumos), nombre, unidad: V.oneOf(f.unidad, ["kg", "g", "l", "unid"], "Unidad"),
      stock: V.num(f.stock, "Stock", 0, 1e6), minimo: V.num(f.minimo, "Mínimo", 0, 1e6) });
    return nombre;
  }),
  ajustarStock: (f) => Data.mutate(ADMIN, "stock_ajuste", (d) => {
    const ins = d.insumos.find((i) => i.id === V.int(f.insumoId, "Insumo", 1, 9999));
    if (!ins) throw new AppError("Insumo no encontrado");
    const delta = V.num(f.delta, "Cantidad", -1e6, 1e6);
    if (delta === 0) throw new AppError("La cantidad no puede ser 0");
    const motivo = V.text(f.motivo, "Motivo", { max: 60 });
    const nuevo = Math.round((ins.stock + delta) * 1000) / 1000;
    if (nuevo < 0) throw new AppError("El stock no puede quedar negativo");
    ins.stock = nuevo;
    return `${ins.nombre} ${delta > 0 ? "+" : ""}${delta} (${motivo})`;
  }),

  reiniciarDemo: () => Data.mutate(ADMIN, "datos_reiniciados", (d) => { Object.assign(d, defaultData()); return ""; }),
};

// ============================ UI helpers ============================
const UI = (() => {
  // h(): crea nodos DOM. Los textos entran como nodos de texto → no se interpreta HTML (anti-XSS).
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    let val;
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "value") val = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    if (val !== undefined) el.value = val;
    return el;
  };
  const money = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
  const LABEL = { disponible: "Disponible", reservada: "Reservada", ocupada: "Ocupada", pendiente: "Pendiente",
    preparando: "En preparación", listo: "Listo", en_ruta: "En ruta", entregado: "Entregado", activa: "Activa", cancelada: "Cancelada",
    abierto: "Abierto", cerrado: "Cerrado" };
  const badge = (estado) => h("span", { class: `badge st-${estado}` }, LABEL[estado] || estado);
  const table = (heads, rows) => h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, heads.map((t) => h("th", {}, t)))),
    h("tbody", {}, rows.length ? rows.map((r) => h("tr", {}, r.map((c) => h("td", {}, c))))
      : h("tr", {}, h("td", { colspan: heads.length, class: "empty" }, "Aún no hay registros")))));
  const field = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
  const select = (name, opts, value) => h("select", { name, value }, opts.map(([v, t]) => h("option", { value: v }, t)));
  function toast(msg, ok = true) {
    const t = h("div", { class: `toast ${ok ? "ok" : "bad"}`, role: "status" }, msg);
    document.getElementById("toasts").append(t);
    setTimeout(() => t.remove(), 4500);
  }
  // Ejecuta una acción, avisa y refresca. Solo mostramos mensajes de AppError (seguros).
  async function act(fn, okMsg = "Listo") {
    try { const r = await fn(); toast(okMsg, true); await App.refresh(); return r; }
    catch (e) { toast(e instanceof AppError ? e.message : "Ocurrió un error inesperado", false); console.error(e); }
  }
  const val = (fd, k) => String(fd.get(k) ?? "");
  return { h, money, badge, table, field, select, toast, act, val };
})();

// ============================ Vistas ============================
const { h, money, badge, table, field, select, act, val } = UI;
const fmtFecha = (ts) => new Date(ts).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" });

const Views = {
  dashboard() {
    const d = Data.get(), hoy = todayStr();
    const itemsAbiertos = d.pedidos.filter((p) => p.estado === "abierto").flatMap((p) => p.items);
    const stats = [
      ["Reservas de hoy", d.reservas.filter((r) => r.estado === "activa" && r.fecha === hoy).length],
      ["Platos pendientes", itemsAbiertos.filter((i) => i.estado !== "listo").length],
      ["Despachos activos", d.despachos.filter((x) => x.estado !== "entregado").length],
      ["Mesas ocupadas", d.mesas.filter((m) => m.estado === "ocupada").length],
    ];
    const bajos = d.insumos.filter((i) => i.stock <= i.minimo);
    return h("div", {},
      h("div", { class: "stats" }, stats.map(([l, v]) => h("div", { class: "card stat" }, h("strong", {}, v), h("span", {}, l)))),
      Auth.can("inventario") && bajos.length ? h("div", { class: "card warn" }, h("h3", {}, "Insumos por reponer"),
        h("ul", {}, bajos.map((i) => h("li", {}, `${i.nombre}: quedan ${i.stock} ${i.unidad} (mínimo ${i.minimo})`)))) : null);
  },

  mesas() {
    return h("div", { class: "grid mesas" }, Data.get().mesas.map((m) =>
      h("div", { class: `card mesa st-${m.estado}` }, h("h3", {}, `Mesa ${m.id}`), h("p", {}, `${m.capacidad} personas`), badge(m.estado))));
  },

  reservas() {
    const d = Data.get();
    const form = h("form", { class: "card form-row", onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      act(() => Ops.crearReserva({ mesaId: Number(val(fd, "mesa")), fecha: val(fd, "fecha"), hora: val(fd, "hora"),
        personas: Number(val(fd, "personas")), cliente: val(fd, "cliente") }), "Reserva creada");
    } },
      field("Mesa", select("mesa", d.mesas.map((m) => [m.id, `Mesa ${m.id} (${m.capacidad})`]))),
      field("Fecha", h("input", { type: "date", name: "fecha", required: true, min: todayStr(), value: todayStr() })),
      field("Hora", h("input", { type: "time", name: "hora", required: true, value: "19:00" })),
      field("Personas", h("input", { type: "number", name: "personas", min: 1, max: 20, required: true, value: 2 })),
      field("Cliente", h("input", { type: "text", name: "cliente", maxlength: 60, required: true, autocomplete: "off" })),
      h("button", { class: "btn primary", type: "submit" }, "Crear reserva"));
    const rows = [...d.reservas].sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora)).map((r) => [
      r.fecha, r.hora, `Mesa ${r.mesaId}`, r.personas, r.cliente, badge(r.estado),
      r.estado === "activa" ? h("button", { class: "btn ghost sm", onclick: () => act(() => Ops.cancelarReserva(r.id), "Reserva cancelada") }, "Cancelar") : ""]);
    return h("div", {}, form, table(["Fecha", "Hora", "Mesa", "Personas", "Cliente", "Estado", ""], rows));
  },

  pedidos() {
    const d = Data.get();
    const form = h("form", { class: "card", onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const items = d.platos.map((p) => ({ platoId: p.id, cantidad: Number(val(fd, "p_" + p.id)) })).filter((i) => i.cantidad > 0);
      act(() => Ops.crearPedido({ mesaId: Number(val(fd, "mesa")), items }), "Pedido enviado a cocina");
    } },
      h("div", { class: "form-row" }, field("Mesa", select("mesa", d.mesas.map((m) => [m.id, `Mesa ${m.id}`])))),
      h("div", { class: "menu-grid" }, d.platos.map((p) => h("label", { class: "plato" },
        h("span", {}, p.nombre), h("small", {}, money(p.precio)),
        h("input", { type: "number", name: "p_" + p.id, min: 0, max: 20, value: 0, "aria-label": `Cantidad de ${p.nombre}` })))),
      h("button", { class: "btn primary", type: "submit" }, "Enviar pedido a cocina"));
    const rows = [...d.pedidos].reverse().map((p) => [
      `#${p.id}`, `Mesa ${p.mesaId}`, fmtFecha(p.ts),
      h("ul", { class: "plain" }, p.items.map((it) => h("li", {}, `${it.cantidad}× ${it.nombre} `, badge(it.estado)))),
      money(p.items.reduce((s, it) => s + it.precio * it.cantidad, 0)), badge(p.estado),
      p.estado === "abierto" ? h("button", { class: "btn ghost sm", onclick: () => act(() => Ops.cerrarPedido(p.id), "Pedido cerrado") }, "Cerrar") : ""]);
    return h("div", {}, form, table(["Pedido", "Mesa", "Hora", "Platos", "Total", "Estado", ""], rows));
  },

  // Cocina: cada plato es una "comanda" tipo ticket
  cocina() {
    const d = Data.get();
    const tickets = d.pedidos.filter((p) => p.estado === "abierto").flatMap((p) =>
      p.items.map((it, idx) => ({ p, it, idx })).filter((x) => x.it.estado !== "listo"))
      .sort((a, b) => a.p.ts - b.p.ts);
    if (!tickets.length) return h("div", { class: "card empty-state" }, h("h3", {}, "Sin comandas pendientes"), h("p", {}, "Cuando un mesero envíe un pedido, aparecerá aquí."));
    return h("div", { class: "grid tickets" }, tickets.map(({ p, it, idx }) => h("article", { class: `ticket st-${it.estado}` },
      h("header", {}, h("strong", {}, `Mesa ${p.mesaId}`), h("small", {}, `Pedido #${p.id} · ${fmtFecha(p.ts)}`)),
      h("p", { class: "dish" }, `${it.cantidad}× ${it.nombre}`),
      h("footer", {}, badge(it.estado),
        h("button", { class: "btn primary sm", onclick: () => act(() => Ops.avanzarPlato(p.id, idx), it.estado === "pendiente" ? "En preparación" : "Plato listo") },
          it.estado === "pendiente" ? "Empezar a preparar" : "Marcar listo")))));
  },

  despachos() {
    const d = Data.get();
    const porDespachar = d.pedidos.filter((p) => p.estado === "abierto" && p.items.some((i) => i.estado === "listo" && !i.despachado));
    return h("div", {},
      h("h3", {}, "Platos listos para llevar"),
      porDespachar.length ? h("div", { class: "grid" }, porDespachar.map((p) => h("div", { class: "card" },
        h("h4", {}, `Mesa ${p.mesaId} · Pedido #${p.id}`),
        h("ul", { class: "plain" }, p.items.filter((i) => i.estado === "listo" && !i.despachado).map((i) => h("li", {}, `${i.cantidad}× ${i.nombre}`))),
        h("button", { class: "btn primary sm", onclick: () => act(() => Ops.crearDespacho(p.id), "Despacho creado") }, "Crear despacho"))))
        : h("p", { class: "muted" }, "No hay platos listos esperando."),
      h("h3", {}, "Despachos"),
      table(["Despacho", "Mesa", "Platos", "Estado", ""], [...d.despachos].reverse().map((x) => [
        `#${x.id}`, `Mesa ${x.mesaId}`, h("ul", { class: "plain" }, x.platos.map((t) => h("li", {}, t))), badge(x.estado),
        x.estado !== "entregado" ? h("button", { class: "btn ghost sm", onclick: () => act(() => Ops.avanzarDespacho(x.id), x.estado === "pendiente" ? "En ruta" : "Entregado") },
          x.estado === "pendiente" ? "Salir a mesa" : "Marcar entregado") : ""])));
  },

  inventario() {
    const d = Data.get();
    const ajuste = h("form", { class: "card form-row", onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      act(() => Ops.ajustarStock({ insumoId: Number(val(fd, "insumo")), delta: Number(val(fd, "delta")), motivo: val(fd, "motivo") }), "Stock actualizado");
    } },
      field("Insumo", select("insumo", d.insumos.map((i) => [i.id, `${i.nombre} (${i.unidad})`]))),
      field("Cantidad (+ entra, − sale)", h("input", { type: "number", name: "delta", step: "any", required: true })),
      field("Motivo", h("input", { type: "text", name: "motivo", maxlength: 60, required: true, placeholder: "Compra, merma, conteo…" })),
      h("button", { class: "btn primary", type: "submit" }, "Ajustar stock"));
    const nuevo = h("form", { class: "card form-row", onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      act(() => Ops.crearInsumo({ nombre: val(fd, "nombre"), unidad: val(fd, "unidad"), stock: Number(val(fd, "stock")), minimo: Number(val(fd, "minimo")) }), "Insumo creado");
    } },
      field("Nuevo insumo", h("input", { type: "text", name: "nombre", maxlength: 40, required: true })),
      field("Unidad", select("unidad", ["kg", "g", "l", "unid"].map((u) => [u, u]))),
      field("Stock inicial", h("input", { type: "number", name: "stock", min: 0, step: "any", required: true, value: 0 })),
      field("Mínimo", h("input", { type: "number", name: "minimo", min: 0, step: "any", required: true, value: 0 })),
      h("button", { class: "btn ghost", type: "submit" }, "Agregar insumo"));
    const rows = d.insumos.map((i) => [i.nombre, `${i.stock} ${i.unidad}`, `${i.minimo} ${i.unidad}`,
      i.stock <= i.minimo ? h("span", { class: "badge st-pendiente" }, "Reponer") : h("span", { class: "badge st-disponible" }, "OK")]);
    return h("div", {}, ajuste, nuevo, table(["Insumo", "Stock", "Mínimo", "Estado"], rows),
      h("h3", {}, "Recetas (descuento automático por plato)"),
      table(["Plato", "Insumos por porción"], d.platos.map((p) => [p.nombre,
        p.receta.map((r) => { const i = d.insumos.find((x) => x.id === r.insumoId); return `${i ? i.nombre : "?"}: ${r.cantidad} ${i ? i.unidad : ""}`; }).join(" · ")])));
  },

  async usuarios() {
    const users = Auth.listUsers();
    const audit = (await Audit.list()).slice(-40).reverse();
    const crear = h("form", { class: "card form-row", onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      act(() => Auth.createUser({ username: val(fd, "username"), password: val(fd, "password"), rol: val(fd, "rol") }), "Usuario creado");
    } },
      field("Usuario", h("input", { type: "text", name: "username", required: true, maxlength: 20, autocomplete: "off" })),
      field("Contraseña inicial", h("input", { type: "password", name: "password", required: true, minlength: 10, autocomplete: "new-password" })),
      field("Rol", select("rol", ROLES.map((r) => [r, r]))),
      h("button", { class: "btn primary", type: "submit" }, "Crear usuario"));
    const rows = users.map((u) => {
      const gForm = h("form", { class: "inline", onsubmit: (e) => { e.preventDefault();
        act(() => Auth.setGoogleEmail(u.username, val(new FormData(e.target), "email")), "Correo actualizado"); } },
        h("input", { type: "email", name: "email", value: u.googleEmail || "", placeholder: "correo@gmail.com", "aria-label": `Correo de Google de ${u.username}` }),
        h("button", { class: "btn ghost sm", type: "submit" }, "Guardar"));
      return [u.username, u.rol, gForm, u.has2FA ? h("span", {}, "Activo ", h("button", { class: "btn ghost sm", onclick: () => act(() => Auth.reset2FA(u.username), "2FA reseteado") }, "Resetear")) : "No",
        u.active ? badge("activa") : badge("cancelada"),
        h("button", { class: "btn ghost sm", onclick: () => act(() => Auth.setActive(u.username, !u.active), u.active ? "Usuario desactivado" : "Usuario activado") }, u.active ? "Desactivar" : "Activar")];
    });
    return h("div", {}, crear, table(["Usuario", "Rol", "Correo Google autorizado", "2FA", "Estado", ""], rows),
      h("h3", {}, "Bitácora de seguridad (últimos 40 eventos)"),
      table(["Fecha", "Usuario", "Evento", "Detalle"], audit.map((a) => [fmtFecha(a.t), a.u, a.e, a.d])),
      h("div", { class: "card" }, h("h3", {}, "Datos de demostración"),
        h("p", { class: "muted" }, "Restablece mesas, platos, inventario, reservas y pedidos. No toca los usuarios."),
        h("button", { class: "btn danger", onclick: () => { if (confirm("¿Restablecer todos los datos de demostración?")) act(() => Ops.reiniciarDemo(), "Datos restablecidos"); } }, "Restablecer datos")));
  },

  seguridad() {
    const pw = h("form", { class: "card", onsubmit: (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      if (val(fd, "nueva") !== val(fd, "repetir")) return UI.toast("Las contraseñas nuevas no coinciden", false);
      act(() => Auth.changePassword(val(fd, "actual"), val(fd, "nueva")), "Contraseña actualizada");
    } },
      h("h3", {}, "Cambiar contraseña"),
      field("Contraseña actual", h("input", { type: "password", name: "actual", required: true, autocomplete: "current-password" })),
      field("Nueva contraseña", h("input", { type: "password", name: "nueva", required: true, minlength: 10, autocomplete: "new-password" })),
      field("Repite la nueva", h("input", { type: "password", name: "repetir", required: true, minlength: 10, autocomplete: "new-password" })),
      h("p", { class: "muted" }, "Mínimo 10 caracteres, con mayúscula, minúscula y número."),
      h("button", { class: "btn primary", type: "submit" }, "Guardar contraseña"));

    const box = h("div", { class: "card" }, h("h3", {}, "Verificación en dos pasos (2FA)"));
    if (Auth.my2FA()) {
      box.append(h("p", {}, "El 2FA está activo en tu cuenta."),
        h("form", { class: "inline", onsubmit: (e) => { e.preventDefault();
          act(() => Auth.disable2FA(val(new FormData(e.target), "pw")), "2FA desactivado"); } },
          h("input", { type: "password", name: "pw", placeholder: "Tu contraseña", required: true, autocomplete: "current-password" }),
          h("button", { class: "btn danger sm", type: "submit" }, "Desactivar 2FA")));
    } else {
      const area = h("div", {});
      box.append(h("p", { class: "muted" }, "Usa Google Authenticator, Authy o similar para generar códigos de 6 dígitos."), area,
        h("button", { class: "btn primary", onclick: (ev) => {
          const s = Auth.begin2FA(); ev.target.hidden = true;
          area.append(h("p", {}, "1. En tu app de autenticación elige «Ingresar clave» y escribe:"),
            h("code", { class: "secret" }, s.secret.match(/.{1,4}/g).join(" ")),
            h("p", { class: "muted" }, "Cuenta: RestoApp · Tipo: basado en tiempo"),
            h("p", {}, "2. Escribe el código de 6 dígitos que muestra la app:"),
            h("form", { class: "inline", onsubmit: (e) => { e.preventDefault();
              act(() => Auth.confirm2FA(val(new FormData(e.target), "code")), "2FA activado"); } },
              h("input", { type: "text", name: "code", inputmode: "numeric", pattern: "\\d{6}", maxlength: 6, required: true, autocomplete: "one-time-code" }),
              h("button", { class: "btn primary sm", type: "submit" }, "Confirmar y activar")));
        } }, "Configurar 2FA"));
    }
    return h("div", {}, pw, box);
  },
};