/* =====================================================================
   PORTAL DE RESIDENTES · FRACCIONAMIENTO
   Firebase v10 (SDK modular vía CDN) · JavaScript ES6+ sin frameworks
   Comparte base de datos con el Panel de Administración.
   ===================================================================== */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-analytics.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  addDoc,
  setDoc,
  updateDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  serverTimestamp,
  Timestamp,
  FieldPath
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ---------------------------------------------------------------------
   1. FIREBASE
   --------------------------------------------------------------------- */
const firebaseConfig = { apiKey: "AIzaSyCNWsowcsixY7I4JDuOzoQfu3Jdx9UFGNQ", authDomain: "doc-con-ia.firebaseapp.com", projectId: "doc-con-ia", storageBucket: "doc-con-ia.firebasestorage.app", messagingSenderId: "952895131866", appId: "1:952895131866:web:edd126a29c7f11e41295e3", measurementId: "G-HWWWE5FW7N" };

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
isSupported().then((ok) => ok && getAnalytics(app)).catch(() => {});

/* ---------------------------------------------------------------------
   2. SESIÓN DEL RESIDENTE
   Se llena al iniciar sesión con el perfil `usuarios/{uid}` que crea el
   administrador al registrar la casa (rol "titular" o "inquilino").
   --------------------------------------------------------------------- */
let perfil = null;          // { uid, nombre, email, rol, casaId, casa, numero, privada, fase, ... }
let casaId = "";            // ID del documento en `casas` (identificador único de la casa)
let casaActual = "";        // Etiqueta visible: "Casa 12 · Privada Roble · Fase 2"
let nombreResidente = "";

/** Qué puede hacer cada perfil en el portal. */
const PERMISOS = {
  titular:   { historialPagos: true,  votar: true,  pases: true, reservar: true, reportar: true },
  inquilino: { historialPagos: false, votar: false, pases: true, reservar: true, reportar: true }
};
const puede = (accion) => Boolean(PERMISOS[perfil?.rol]?.[accion]);

/* ---------------------------------------------------------------------
   3. CONFIGURACIÓN (mismas colecciones que el Panel Admin)
   --------------------------------------------------------------------- */
const COL = {
  casas: "casas",
  usuarios: "usuarios",
  comunicados: "comunicados",
  pases: "pases_qr",
  incidencias: "incidencias",
  reservaciones: "reservaciones"
};

const CONFIG = {
  campoFecha: "fecha",     // mismo campo de fecha que usa el panel admin
  horaApertura: 7,         // primera hora reservable (07:00)
  horaCierre: 22,          // las amenidades cierran a las 22:00
  diasAnticipacion: 30,    // máximo de días a futuro para reservar
  prefijoQR: "FRACC"       // prefijo de los códigos QR que lee la caseta
};

/* ---------------------------------------------------------------------
   4. ESTADO
   --------------------------------------------------------------------- */
const state = {
  casa: null,
  casaLista: false,
  comunicados: [],
  pases: [],
  reservas: [],
  reportes: [],
  cargado: { comunicados: false, pases: false, reservas: false, reportes: false },
  filtroFeed: "todos",
  expandidos: new Set(),
  anioVista: new Date().getFullYear(),
  paseActual: null,
  fotoReporte: null,
  unsubs: []
};

/* ---------------------------------------------------------------------
   5. UTILIDADES
   --------------------------------------------------------------------- */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const pick = (obj, keys, def = "") => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return def;
};

const pad = (n) => String(n).padStart(2, "0");

const normalizar = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "object" && "seconds" in v) return new Date(v.seconds * 1000);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

const fechaDoc = (o) => {
  for (const k of [CONFIG.campoFecha, "fecha", "creadoEn", "createdAt", "timestamp"]) {
    const d = toDate(o?.[k]);
    if (d) return d;
  }
  return null;
};

const claveDia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const claveMes = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const valorLocal = (d) => `${claveDia(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const fmt = (d, opts) => (d ? new Intl.DateTimeFormat("es-MX", opts).format(d) : "—");
const fmtFechaHora = (d) => fmt(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtFechaLarga = (d) => fmt(d, { weekday: "long", day: "numeric", month: "long" });

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
function hace(d) {
  if (!d) return "";
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 60) return "ahora";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 604800) return rtf.format(Math.round(s / 86400), "day");
  return fmt(d, { day: "numeric", month: "short", year: "numeric" });
}

const mapDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
const ordenarDesc = (arr) => arr.sort((a, b) => (fechaDoc(b)?.getTime() || 0) - (fechaDoc(a)?.getTime() || 0));

const badge = (txt, tipo = "neutral") => `<span class="badge badge--${tipo}">${esc(txt)}</span>`;
const vacio = (txt, ic = "check") => `<li class="empty">${icon(ic)}<span>${esc(txt)}</span></li>`;

function codigoAleatorio(bytes = 6) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function conCarga(btn, fn) {
  btn.disabled = true;
  btn.classList.add("is-loading");
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-loading");
  }
}

function toast(msg, tipo = "info", ms = 3500) {
  const iconos = { success: "check", error: "alert", warning: "alert", info: "megaphone" };
  const el = document.createElement("div");
  el.className = `toast toast--${tipo}`;
  el.setAttribute("role", tipo === "error" ? "alert" : "status");
  el.innerHTML = `${icon(iconos[tipo] || "megaphone")}<span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));
  setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function manejarError(contexto, err) {
  console.error(`[${contexto}]`, err);
  const msg =
    err?.code === "permission-denied"
      ? `Sin permiso para ${contexto}. Avisa a la administración.`
      : err?.code === "unavailable"
        ? "Sin conexión con el servidor."
        : `No se pudo cargar ${contexto}.`;
  toast(msg, "error", 5000);
}

/* ---------------------------------------------------------------------
   6. HOJA INFERIOR (modal) Y ALERTAS
   --------------------------------------------------------------------- */
function abrirSheet(titulo, html) {
  $("#sheet-title").textContent = titulo;
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.classList.add("no-scroll");
}

function cerrarSheet() {
  $("#sheet").hidden = true;
  $("#sheet-body").innerHTML = "";
  document.body.classList.remove("no-scroll");
}

/** Alerta estilo app nativa. tipo: error | success | warning */
function alerta({ tipo = "error", titulo, mensaje, encabezado = "Aviso", accion = null }) {
  const iconos = { error: "x", success: "check", warning: "alert" };
  abrirSheet(
    encabezado,
    `<div class="sheet__center">
       <span class="alert-icon alert-icon--${tipo}">${icon(iconos[tipo])}</span>
       <p class="sheet__big">${esc(titulo)}</p>
       <p class="sheet__muted">${esc(mensaje)}</p>
     </div>
     <div class="btn-row">
       ${
         accion
           ? `<button type="button" class="btn btn--ghost" data-close-sheet>Cerrar</button>
              <button type="button" class="btn btn--primary" data-close-sheet data-go="${esc(accion.go)}">${esc(accion.texto)}</button>`
           : `<button type="button" class="btn btn--primary btn--block" data-close-sheet>Entendido</button>`
       }
     </div>`
  );
}

/* ---------------------------------------------------------------------
   7. CÓDIGOS QR (qrcode.js)
   --------------------------------------------------------------------- */
function pintarQR(contenedor, texto, size = 512) {
  contenedor.innerHTML = "";
  if (typeof window.QRCode === "undefined") {
    contenedor.innerHTML = `<p class="sheet__muted">No se pudo cargar el generador de QR. Revisa tu conexión.</p>`;
    return false;
  }
  new window.QRCode(contenedor, {
    text: texto,
    width: size,
    height: size,
    colorDark: "#111827",
    colorLight: "#ffffff",
    correctLevel: window.QRCode.CorrectLevel.M
  });
  return true;
}

/** Compone una imagen con encabezado + QR + datos, lista para enviar por WhatsApp. */
function componerImagen(contenedor, titulo, lineas) {
  const qr = contenedor.querySelector("canvas");
  if (!qr) return null;
  const W = 720;
  const margen = 48;
  const qrSize = W - margen * 2;
  const H = 150 + qrSize + 40 + lineas.length * 44 + 60;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "#4f46e5");
  grad.addColorStop(1, "#7c3aed");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 120);

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 40px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(recortar(ctx, titulo, W - 60), W / 2, 76);

  ctx.drawImage(qr, margen, 150, qrSize, qrSize);

  ctx.fillStyle = "#111827";
  let y = 150 + qrSize + 64;
  lineas.forEach((l, i) => {
    ctx.font = i === 0 ? "800 36px Inter, system-ui, sans-serif" : "500 28px Inter, system-ui, sans-serif";
    ctx.fillStyle = i === 0 ? "#111827" : "#4b5563";
    ctx.fillText(recortar(ctx, l, W - 60), W / 2, y);
    y += 44;
  });
  return c;
}

function recortar(ctx, texto, max) {
  let t = String(texto);
  if (ctx.measureText(t).width <= max) return t;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

async function compartirCanvas(canvas, nombre, textoCompartir) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return descargarCanvas(canvas, nombre);
  const file = new File([blob], `${nombre}.png`, { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: nombre, text: textoCompartir });
      return;
    }
  } catch (err) {
    if (err?.name === "AbortError") return; // el usuario canceló
  }
  descargarCanvas(canvas, nombre);
  toast("Tu dispositivo no permite compartir directo; se descargó la imagen.", "info");
}

function descargarCanvas(canvas, nombre) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `${nombre.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "pase"}.png`;
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------------
   8. NAVEGACIÓN (bottom bar)
   --------------------------------------------------------------------- */
const VISTAS = ["inicio", "pagos", "pases", "reservar", "reportes"];

function irA(vista) {
  if (!VISTAS.includes(vista)) vista = "inicio";
  $$(".view").forEach((v) => {
    const activa = v.id === `view-${vista}`;
    v.hidden = !activa;
    v.classList.toggle("is-active", activa);
  });
  $$(".bottom-nav__item").forEach((b) => {
    const activa = b.dataset.go === vista;
    b.classList.toggle("is-active", activa);
    if (activa) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  history.replaceState(null, "", `#${vista}`);
  window.scrollTo({ top: 0 });
  if (vista === "reservar") actualizarDisponibilidad();
}

/* ---------------------------------------------------------------------
   9. CASA Y ESTATUS DE PAGO
   --------------------------------------------------------------------- */
function estaPagada(c) {
  if (!c) return false;
  const v = pick(c, ["estatusPago", "estatus", "estado"], c.pagado);
  if (typeof v === "boolean") return v;
  return /^pagad/i.test(String(v ?? "").trim());
}

const faseTexto = (f) => (f === undefined || f === null || f === "" ? "" : /^\d/.test(String(f)) ? `Fase ${f}` : String(f));
const etiquetaDeCasa = (c) =>
  c.etiqueta || [`Casa ${pick(c, ["numero", "numeroCasa"], "")}`, c.privada, faseTexto(c.fase)].filter(Boolean).join(" · ");

/** Escucha en tiempo real el documento de la casa del residente (por su ID). */
function suscribirCasa() {
  return [
    onSnapshot(
      doc(db, COL.casas, casaId),
      (snap) => {
        state.casa = snap.exists() ? { id: snap.id, ...snap.data({ serverTimestamps: "estimate" }) } : null;
        state.casaLista = true;
        if (state.casa) {
          casaActual = etiquetaDeCasa(state.casa);
          pintarEncabezado();
        }
        renderPago();
      },
      (err) => manejarError("tu estatus de pago", err)
    )
  ];
}

/**
 * LÓGICA VITAL: consulta directamente al servidor (sin caché) si la casa
 * tiene el mantenimiento pagado justo antes de reservar.
 */
async function verificarPagoEnServidor() {
  const snap = await getDocFromServer(doc(db, COL.casas, casaId));
  if (!snap.exists()) return { encontrada: false, pagada: false };
  const casa = { id: snap.id, ...snap.data() };
  return { encontrada: true, pagada: estaPagada(casa), casa };
}

/** Conjunto de meses "YYYY-MM" pagados según el documento de la casa. */
function mesesPagados(casa) {
  const set = new Set();
  if (!casa) return set;
  const fuentes = [casa.mesesPagados, casa.historialPagos, casa.pagos].filter(Array.isArray).flat();
  fuentes.forEach((x) => {
    let v = x;
    if (x && typeof x === "object" && typeof x.toDate !== "function") v = x.mes ?? x.periodo ?? x.fecha;
    if (typeof v === "string" && /^\d{4}-\d{2}/.test(v)) set.add(v.slice(0, 7));
    else {
      const d = toDate(v);
      if (d) set.add(claveMes(d));
    }
  });
  if (estaPagada(casa)) {
    set.add(claveMes(new Date())); // estatus "Pagado" = periodo actual cubierto
    const fp = toDate(casa.fechaPago);
    if (fp) set.add(claveMes(fp));
  }
  return set;
}

function renderPago() {
  const pill = $("#pill-pago");
  const hero = $("#hero-pago");
  const card = $("#status-card");
  pill.classList.remove("is-loading", "is-ok", "is-bad");
  hero.classList.remove("is-ok", "is-bad");
  card.classList.remove("is-ok", "is-bad");

  const casa = state.casa;
  const mesActual = fmt(new Date(), { month: "long" });
  const fechaPago = toDate(casa?.fechaPago);

  let pillTxt, heroBadge, heroTitle, heroSub, statusVal, statusMeta, ic, clase;
  if (!casa) {
    clase = "";
    pillTxt = "Sin registro";
    heroBadge = "Sin registro";
    heroTitle = "Casa no encontrada";
    heroSub = `${casaActual} no aparece en el padrón. Contacta a la administración.`;
    statusVal = "Sin registro";
    statusMeta = "Tu casa aún no ha sido dada de alta por la administración.";
    ic = "alert";
  } else if (estaPagada(casa)) {
    clase = "is-ok";
    pillTxt = "Al corriente";
    heroBadge = "Pagado";
    heroTitle = "¡Estás al corriente!";
    heroSub = fechaPago ? `Último pago registrado: ${fmt(fechaPago, { day: "numeric", month: "long", year: "numeric" })}` : "Gracias por mantener tu cuota al día.";
    statusVal = "Pagado";
    statusMeta = fechaPago ? `Registrado el ${fmtFechaHora(fechaPago)}` : "Periodo actual cubierto";
    ic = "check";
  } else {
    clase = "is-bad";
    pillTxt = "Pendiente";
    heroBadge = "No pagado";
    heroTitle = "Pago pendiente";
    heroSub = `Tu cuota de ${mesActual} aún no está registrada. Las reservaciones están bloqueadas.`;
    statusVal = "No pagado";
    statusMeta = fechaPago ? `Último pago: ${fmtFechaHora(fechaPago)}` : "Sin pagos registrados en el periodo";
    ic = "alert";
  }

  if (clase) {
    pill.classList.add(clase);
    hero.classList.add(clase);
    card.classList.add(clase);
  }
  $("#pill-pago-text").textContent = pillTxt;
  $("#hero-badge").textContent = heroBadge;
  $("#hero-title").textContent = heroTitle;
  $("#hero-sub").textContent = heroSub;
  $("#status-value").textContent = statusVal;
  $("#status-meta").textContent = statusMeta;
  $("#status-icon").innerHTML = icon(ic);

  renderMeses();
  renderBannerReserva();
}

function renderMeses() {
  $("#card-historial").hidden = !puede("historialPagos");
  $("#nota-historial").hidden = puede("historialPagos");
  if (!puede("historialPagos")) return;
  const anio = state.anioVista;
  const hoy = new Date();
  const pagados = mesesPagados(state.casa);
  const alta = fechaDoc(state.casa || {});
  const inicioAlta = alta ? new Date(alta.getFullYear(), alta.getMonth(), 1) : null;
  const etiquetas = {
    pagado: ["Pagado", "check"],
    pendiente: ["En curso", "clock"],
    adeudo: ["Sin pago", "x"],
    futuro: ["Próximo", null],
    na: ["N/A", null]
  };

  let cuentaPagados = 0;
  let cuentaVencidos = 0;
  let html = "";
  for (let m = 0; m < 12; m++) {
    const inicioMes = new Date(anio, m, 1);
    const clave = claveMes(inicioMes);
    let estado;
    if (pagados.has(clave)) estado = "pagado";
    else if (inicioAlta && inicioMes < inicioAlta) estado = "na";
    else if (clave === claveMes(hoy)) estado = "pendiente";
    else if (inicioMes > hoy) estado = "futuro";
    else estado = "adeudo";

    if (estado === "pagado") cuentaPagados++;
    if (estado !== "futuro" && estado !== "na") cuentaVencidos++;

    const [txt, ic] = etiquetas[estado];
    const nombre = fmt(inicioMes, { month: "short" }).replace(".", "");
    html += `<div class="month month--${estado}" role="listitem" aria-label="${esc(fmt(inicioMes, { month: "long" }))}: ${txt}">
      ${ic ? icon(ic) : ""}
      <span class="month__name">${esc(nombre)}</span>
      <span class="month__state">${txt}</span>
    </div>`;
  }

  $("#meses-grid").innerHTML = html;
  $("#anio-label").textContent = anio;
  $("#anio-resumen").textContent = state.casa
    ? `${cuentaPagados} de ${cuentaVencidos} ${cuentaVencidos === 1 ? "mes pagado" : "meses pagados"}`
    : "Sin información de pagos";
  $("#anio-next").disabled = anio >= hoy.getFullYear();
}

$("#anio-prev").addEventListener("click", () => {
  state.anioVista--;
  renderMeses();
});
$("#anio-next").addEventListener("click", () => {
  if (state.anioVista < new Date().getFullYear()) {
    state.anioVista++;
    renderMeses();
  }
});

/* ---------------------------------------------------------------------
   10. MURO DE NOVEDADES
   --------------------------------------------------------------------- */
const TIPOS = {
  noticia: { clase: "Noticia", badge: "info", label: "Noticia" },
  aviso: { clase: "Aviso", badge: "warning", label: "Aviso" },
  evento: { clase: "Evento", badge: "success", label: "Evento" },
  votacion: { clase: "Votacion", badge: "primary", label: "Votación" }
};
const tipoDe = (c) => TIPOS[normalizar(pick(c, ["tipo"], "noticia")).replace(/[^a-z]/g, "")] || TIPOS.noticia;

function renderFeed() {
  const cont = $("#feed");
  if (!state.cargado.comunicados) return;

  const filtro = normalizar(state.filtroFeed);
  const lista = state.comunicados.filter((c) => filtro === "todos" || normalizar(tipoDe(c).label) === filtro);

  if (!lista.length) {
    cont.innerHTML = `<div class="empty">${icon("megaphone")}<span>${
      filtro === "todos" ? "Aún no hay publicaciones de la administración." : "No hay publicaciones de este tipo."
    }</span></div>`;
    return;
  }

  cont.innerHTML = lista
    .map((c) => {
      const t = tipoDe(c);
      const texto = pick(c, ["contenido", "mensaje", "descripcion"], "");
      const largo = texto.length > 220;
      const expandido = state.expandidos.has(c.id);
      const fe = toDate(c.fechaEvento);
      return `<article class="post post--${t.clase} ${c.prioridad === "alta" ? "is-alta" : ""}">
        <div class="post__top">
          <div class="post__tags">${badge(t.label, t.badge)}${c.prioridad === "alta" ? badge("Importante", "danger") : ""}</div>
          <span class="post__time">${esc(hace(fechaDoc(c)))}</span>
        </div>
        <h3 class="post__title">${esc(pick(c, ["titulo"], "Sin título"))}</h3>
        ${texto ? `<p class="post__text ${largo && !expandido ? "is-collapsed" : ""}">${esc(texto)}</p>` : ""}
        ${largo ? `<button type="button" class="link-btn" data-action="expandir" data-id="${esc(c.id)}">${expandido ? "Ver menos" : "Ver más"}</button>` : ""}
        ${
          fe || c.lugar
            ? `<div class="post__event">
                 ${fe ? `<span>${icon("calendar")}${esc(fmtFechaLarga(fe))}, ${esc(fmt(fe, { hour: "2-digit", minute: "2-digit" }))}</span>` : ""}
                 ${c.lugar ? `<span>${icon("pin")}${esc(c.lugar)}</span>` : ""}
               </div>`
            : ""
        }
        ${t.clase === "Votacion" ? htmlVotacion(c) : ""}
      </article>`;
    })
    .join("");
}

function htmlVotacion(c) {
  const opciones = Array.isArray(c.opciones) ? c.opciones.filter(Boolean) : [];
  if (!opciones.length) return "";
  const votos = c.votos && typeof c.votos === "object" ? c.votos : {};
  const mio = votos[casaId];
  const puedeVotar = puede("votar");
  const total = Object.keys(votos).length;
  const cierre = toDate(c.cierre);
  const cerrada = c.cerrada === true || (cierre && cierre < new Date());
  const verResultados = Boolean(mio) || cerrada || !puedeVotar;

  const conteo = opciones.map((o) => Object.values(votos).filter((v) => v === o).length);
  const filas = opciones
    .map((o, i) => {
      const pct = total ? Math.round((conteo[i] / total) * 100) : 0;
      const esMio = mio === o;
      return `<button type="button" class="poll__opt ${esMio ? "is-mine" : ""}" data-action="votar" data-id="${esc(c.id)}" data-opcion="${i}" ${cerrada || !puedeVotar ? "disabled" : ""} aria-pressed="${esMio}">
        <span class="poll__fill" style="width:${verResultados ? pct : 0}%"></span>
        <span class="poll__label">${esMio ? icon("check") : ""}${esc(o)}</span>
        ${verResultados ? `<span class="poll__pct">${pct}%</span>` : ""}
      </button>`;
    })
    .join("");

  const pie = !puedeVotar
    ? `${total} ${total === 1 ? "voto" : "votos"} · Solo los titulares de la casa pueden votar`
    : cerrada
    ? `Votación cerrada · ${total} ${total === 1 ? "voto" : "votos"}`
    : mio
      ? `${total} ${total === 1 ? "voto" : "votos"} · Puedes cambiar tu voto${cierre ? ` hasta el ${fmtFechaHora(cierre)}` : ""}`
      : `Un voto por casa${cierre ? ` · Cierra el ${fmtFechaHora(cierre)}` : ""}`;

  return `<div class="poll">${filas}<p class="poll__foot">${esc(pie)}</p></div>`;
}

async function votar(btn) {
  const c = state.comunicados.find((x) => x.id === btn.dataset.id);
  const opcion = c?.opciones?.[Number(btn.dataset.opcion)];
  if (!puede("votar")) return toast("Solo los titulares de la casa pueden votar.", "warning");
  if (!c || !opcion || c.votos?.[casaId] === opcion) return;
  try {
    btn.disabled = true;
    await updateDoc(doc(db, COL.comunicados, c.id), new FieldPath("votos", casaId), opcion);
    toast("¡Voto registrado!", "success");
  } catch (err) {
    btn.disabled = false;
    manejarError("registrar tu voto", err);
  }
}

$("#feed-filtro").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filtro]");
  if (!b) return;
  state.filtroFeed = b.dataset.filtro;
  $$("#feed-filtro .pill").forEach((x) => x.classList.toggle("is-active", x === b));
  renderFeed();
});

/* ---------------------------------------------------------------------
   11. PASES QR PARA VISITAS
   --------------------------------------------------------------------- */
const formPase = $("#form-pase");

function prepararFormPase() {
  const ahora = new Date();
  ahora.setMinutes(Math.ceil(ahora.getMinutes() / 15) * 15, 0, 0);
  formPase.llegada.value = valorLocal(ahora);
  const min = new Date();
  min.setHours(0, 0, 0, 0);
  formPase.llegada.min = valorLocal(min);
  const max = new Date();
  max.setDate(max.getDate() + CONFIG.diasAnticipacion);
  formPase.llegada.max = valorLocal(max);
}

function estadoPase(p) {
  const est = normalizar(pick(p, ["estatus", "estado"], "activo"));
  const desde = toDate(p.validoDesde);
  const hasta = toDate(p.validoHasta);
  const ahora = new Date();
  if (/cancel/.test(est)) return ["Cancelado", "neutral", false];
  if (/usad|utiliz/.test(est)) return ["Utilizado", "info", false];
  if (hasta && hasta < ahora) return ["Expirado", "neutral", false];
  if (desde && desde > ahora) return ["Programado", "warning", true];
  return ["Vigente", "success", true];
}

const textoQRPase = (p) => p.qr || `${CONFIG.prefijoQR}|PASE|${p.id}|${p.codigo}`;

function infoPaseHTML(p) {
  const filas = [
    ["Visita", p.visitante],
    ["Tipo", p.tipoVisita],
    ["Casa", p.casa],
    ["Válido desde", fmtFechaHora(toDate(p.validoDesde))],
    ["Válido hasta", fmtFechaHora(toDate(p.validoHasta))],
    p.placas ? ["Placas", p.placas] : null,
    ["Código", p.codigo]
  ].filter(Boolean);
  return filas.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd></div>`).join("");
}

function mostrarPaseGenerado(p) {
  state.paseActual = p;
  pintarQR($("#pase-qr"), textoQRPase(p));
  $("#pase-info").innerHTML = infoPaseHTML(p);
  $("#pase-resultado").hidden = false;
  $("#pase-resultado").scrollIntoView({ behavior: "smooth", block: "start" });
}

formPase.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#pase-error");
  err.textContent = "";

  const visitante = formPase.visitante.value.trim().replace(/\s+/g, " ");
  const desde = formPase.llegada.value ? new Date(formPase.llegada.value) : null;
  const horas = Number(formPase.duracion.value);

  if (visitante.length < 3) return (err.textContent = "Escribe el nombre completo de tu visita.");
  if (!desde || isNaN(desde)) return (err.textContent = "Indica la fecha y hora de llegada.");
  if (desde.getTime() < Date.now() - 30 * 60 * 1000) return (err.textContent = "La fecha de llegada ya pasó.");
  const limite = new Date();
  limite.setDate(limite.getDate() + CONFIG.diasAnticipacion);
  if (desde > limite) return (err.textContent = `Solo puedes generar pases con ${CONFIG.diasAnticipacion} días de anticipación.`);

  const hasta = new Date(desde.getTime() + horas * 3600 * 1000);
  const ref = doc(collection(db, COL.pases)); // ID generado del lado del cliente
  const codigo = codigoAleatorio();
  const pase = {
    visitante,
    tipoVisita: formPase.tipoVisita.value,
    placas: formPase.placas.value.trim().toUpperCase(),
    casa: casaActual,
    casaId,
    residente: nombreResidente,
    rolCreador: perfil.rol,
    codigo,
    qr: `${CONFIG.prefijoQR}|PASE|${ref.id}|${codigo}`,
    validoDesde: Timestamp.fromDate(desde),
    validoHasta: Timestamp.fromDate(hasta),
    duracionHoras: horas,
    estatus: "activo",
    usos: 0,
    uidCreador: auth.currentUser?.uid || null,
    [CONFIG.campoFecha]: serverTimestamp()
  };

  await conCarga($("#btn-pase"), async () => {
    const guardado = setDoc(ref, pase);
    mostrarPaseGenerado({ id: ref.id, ...pase }); // se muestra de inmediato (funciona sin conexión)
    try {
      await guardado;
      toast("Pase guardado. Compártelo con tu visita.", "success");
      formPase.reset();
      prepararFormPase();
    } catch (ex) {
      $("#pase-resultado").hidden = true;
      manejarError("guardar el pase", ex);
    }
  });
});

$("#pase-cerrar").addEventListener("click", () => ($("#pase-resultado").hidden = true));

function verPase(id) {
  const p = state.pases.find((x) => x.id === id);
  if (!p) return;
  state.paseActual = p;
  abrirSheet(
    "Pase de visita",
    `<div class="qr-box" id="sheet-qr-pase"></div>
     <dl class="pass__info">${infoPaseHTML(p)}</dl>
     <div class="btn-row">
       <button type="button" class="btn btn--ghost" data-action="descargar-pase" data-target="#sheet-qr-pase">${icon("download")} Descargar</button>
       <button type="button" class="btn btn--primary" data-action="compartir-pase" data-target="#sheet-qr-pase">${icon("share")} Compartir</button>
     </div>`
  );
  pintarQR($("#sheet-qr-pase"), textoQRPase(p));
}

function imagenPase(target) {
  const p = state.paseActual;
  const cont = $(target || "#pase-qr");
  if (!p || !cont) return null;
  return componerImagen(cont, "Pase de acceso", [
    p.visitante,
    `${p.casa} · ${p.tipoVisita || "Visita"}`,
    `Desde ${fmtFechaHora(toDate(p.validoDesde))}`,
    `Hasta ${fmtFechaHora(toDate(p.validoHasta))}`
  ]);
}

async function cancelarPase(id, btn) {
  const p = state.pases.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`¿Cancelar el pase de ${p.visitante}? Ya no podrá usarse en caseta.`)) return;
  try {
    await conCarga(btn, () => updateDoc(doc(db, COL.pases, id), { estatus: "cancelado", canceladoEn: serverTimestamp() }));
    toast("Pase cancelado", "success");
  } catch (err) {
    manejarError("cancelar el pase", err);
  }
}

function renderPases() {
  const cont = $("#lista-pases");
  if (!state.cargado.pases) return;
  const lista = state.pases.slice(0, 25);
  cont.innerHTML =
    lista
      .map((p) => {
        const [txt, tipo, activo] = estadoPase(p);
        return `<li class="item">
          <span class="item__icon ${activo ? "" : "item__icon--muted"}">${icon("ticket")}</span>
          <div class="item__body">
            <div class="item__row">
              <span class="item__title">${esc(p.visitante || "Visita")}</span>
              ${badge(txt, tipo)}
            </div>
            <span class="item__sub">${esc(p.tipoVisita || "Visita")}${p.placas ? ` · ${esc(p.placas)}` : ""}</span>
            <span class="item__sub">${esc(fmtFechaHora(toDate(p.validoDesde)))} → ${esc(fmtFechaHora(toDate(p.validoHasta)))}</span>
            ${
              activo
                ? `<div class="item__actions">
                     <button type="button" class="btn btn--ghost btn--sm" data-action="ver-pase" data-id="${esc(p.id)}">${icon("qr")} Ver QR</button>
                     <button type="button" class="btn btn--danger-ghost btn--sm" data-action="cancelar-pase" data-id="${esc(p.id)}">${icon("x")} Cancelar</button>
                   </div>`
                : ""
            }
          </div>
        </li>`;
      })
      .join("") || vacio("Aún no has generado pases.", "ticket");
}

/* ---------------------------------------------------------------------
   12. RESERVACIÓN DE AMENIDADES
   --------------------------------------------------------------------- */
const formRes = $("#form-reserva");
let tokenDisponibilidad = 0;

function prepararFormReserva() {
  const hoy = new Date();
  // Si ya no quedan horarios hoy, el primer día reservable es mañana
  if (hoy.getHours() >= CONFIG.horaCierre - 1) hoy.setDate(hoy.getDate() + 1);
  const max = new Date();
  max.setDate(max.getDate() + CONFIG.diasAnticipacion);
  formRes.fecha.min = claveDia(hoy);
  formRes.fecha.max = claveDia(max);
  if (!formRes.fecha.value) formRes.fecha.value = claveDia(hoy);
  poblarHoras(new Set());
}

function poblarHoras(ocupadas) {
  const sel = formRes.hora;
  const previo = sel.value;
  const esHoy = formRes.fecha.value === claveDia(new Date());
  const horaActual = new Date().getHours();
  let html = "";
  let primeraLibre = null;

  for (let h = CONFIG.horaApertura; h < CONFIG.horaCierre; h++) {
    const val = `${pad(h)}:00`;
    const pasada = esHoy && h <= horaActual;
    const ocupada = ocupadas.has(val);
    const deshabilitada = pasada || ocupada;
    if (!deshabilitada && primeraLibre === null) primeraLibre = val;
    const sufijo = ocupada ? " · Ocupado" : pasada ? " · No disponible" : "";
    html += `<option value="${val}" ${deshabilitada ? "disabled" : ""}>${val} – ${pad(h + 1)}:00${sufijo}</option>`;
  }
  if (primeraLibre === null) html = `<option value="" disabled selected>Sin horarios disponibles</option>` + html;
  sel.innerHTML = html;

  const opcionPrevia = [...sel.options].find((o) => o.value === previo && !o.disabled);
  sel.value = opcionPrevia ? previo : primeraLibre ?? "";
}

const estatusReserva = (r) => {
  const e = normalizar(pick(r, ["estatus", "estado"], "pendiente"));
  if (/aprob|acept|confirm/.test(e)) return "aprobada";
  if (/deneg|rechaz/.test(e)) return "denegada";
  if (/cancel/.test(e)) return "cancelada";
  return "pendiente";
};
const minutos = (h) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(h || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Horarios ya tomados (pendientes o aprobados) para la amenidad y fecha elegidas. */
async function horariosOcupados(amenidad, fecha, desdeServidor = false) {
  const q = query(collection(db, COL.reservaciones), where("fechaReserva", "==", fecha));
  const snap = desdeServidor ? await getDocsFromServer(q) : await getDocs(q);
  const ocupadas = new Set();
  snap.docs.forEach((d) => {
    const r = d.data();
    if (normalizar(r.amenidad) !== normalizar(amenidad)) return;
    if (["denegada", "cancelada"].includes(estatusReserva(r))) return;
    const ini = minutos(r.horaInicio);
    const fin = minutos(r.horaFin) ?? (ini !== null ? ini + 60 : null);
    if (ini === null) return;
    for (let h = CONFIG.horaApertura; h < CONFIG.horaCierre; h++) {
      if (h * 60 < fin && ini < (h + 1) * 60) ocupadas.add(`${pad(h)}:00`);
    }
  });
  return ocupadas;
}

async function actualizarDisponibilidad() {
  const amenidad = formRes.amenidad.value;
  const fecha = formRes.fecha.value;
  if (!amenidad || !fecha) return;
  const token = ++tokenDisponibilidad;
  poblarHoras(new Set());
  try {
    const ocupadas = await horariosOcupados(amenidad, fecha);
    if (token === tokenDisponibilidad) poblarHoras(ocupadas);
  } catch (err) {
    console.warn("Disponibilidad no consultada:", err);
  }
}

formRes.addEventListener("change", (e) => {
  if (["amenidad", "fecha"].includes(e.target.name)) actualizarDisponibilidad();
});

function renderBannerReserva() {
  const b = $("#reserva-banner");
  if (!state.casaLista) return;
  const ok = estaPagada(state.casa);
  b.hidden = false;
  b.className = `banner ${ok ? "banner--ok" : "banner--bad"}`;
  b.innerHTML = ok
    ? `${icon("check")}<span>Tu mantenimiento está al corriente. Puedes solicitar reservaciones.</span>`
    : `${icon("lock")}<span>${state.casa ? "Tu mantenimiento tiene pago pendiente. No podrás reservar hasta regularizarlo." : "Tu casa no está registrada en el sistema. Contacta a la administración."}</span>`;
}

formRes.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reserva-error");
  err.textContent = "";

  const amenidad = formRes.amenidad.value;
  const fecha = formRes.fecha.value;
  const hora = formRes.hora.value;
  const invitados = formRes.invitados.value ? Number(formRes.invitados.value) : null;
  const notas = formRes.notas.value.trim();

  if (!amenidad) return (err.textContent = "Elige una instalación.");
  if (!fecha) return (err.textContent = "Elige la fecha.");
  if (!hora) return (err.textContent = "No hay horarios disponibles ese día. Prueba otra fecha.");
  const inicio = new Date(`${fecha}T${hora}`);
  if (inicio <= new Date()) return (err.textContent = "Ese horario ya pasó. Elige otro.");
  if (invitados !== null && (invitados < 1 || invitados > 80)) return (err.textContent = "El número de personas debe estar entre 1 y 80.");

  await conCarga($("#btn-reserva"), async () => {
    // 1) Verificación obligatoria del mantenimiento directamente en Firestore
    let verificacion;
    try {
      verificacion = await verificarPagoEnServidor();
    } catch (ex) {
      console.error(ex);
      alerta({
        tipo: "warning",
        encabezado: "Reservación",
        titulo: "No pudimos verificar tu pago",
        mensaje: "Necesitas conexión a internet para reservar. Inténtalo de nuevo en un momento."
      });
      return;
    }

    if (!verificacion.encontrada) {
      alerta({
        tipo: "error",
        encabezado: "Reservación",
        titulo: "Casa no registrada",
        mensaje: `${casaActual} no aparece en el padrón del fraccionamiento. Contacta a la administración.`
      });
      return;
    }

    if (!verificacion.pagada) {
      alerta({
        tipo: "error",
        encabezado: "Reservación denegada",
        titulo: "Reserva denegada",
        mensaje: "Tu mantenimiento no está al corriente. Para usar las amenidades necesitas tener tu cuota pagada.",
        accion: { go: "pagos", texto: "Ver mis pagos" }
      });
      return;
    }

    // 2) Verificar que el horario siga libre (consulta al servidor)
    try {
      const ocupadas = await horariosOcupados(amenidad, fecha, true);
      if (ocupadas.has(hora)) {
        poblarHoras(ocupadas);
        alerta({
          tipo: "warning",
          encabezado: "Reservación",
          titulo: "Horario ocupado",
          mensaje: "Alguien más acaba de solicitar ese horario. Elige otra hora."
        });
        return;
      }
    } catch (ex) {
      console.warn("No se validó el empalme:", ex);
    }

    // 3) Guardar la solicitud (el admin la aprueba o deniega)
    const h = Number(hora.slice(0, 2));
    try {
      await addDoc(collection(db, COL.reservaciones), {
        amenidad,
        fechaReserva: fecha,
        horaInicio: hora,
        horaFin: `${pad(h + 1)}:00`,
        invitados,
        notas,
        casa: casaActual,
        casaId,
        residente: nombreResidente,
        rolSolicitante: perfil.rol,
        estatus: "pendiente",
        uidSolicitante: auth.currentUser?.uid || null,
        [CONFIG.campoFecha]: serverTimestamp()
      });
      alerta({
        tipo: "success",
        encabezado: "Reservación",
        titulo: "Solicitud enviada",
        mensaje: `${amenidad}, ${fmtFechaLarga(toDate(fecha))} de ${hora} a ${pad(h + 1)}:00. Te avisaremos cuando la administración la revise.`
      });
      formRes.invitados.value = "";
      formRes.notas.value = "";
      actualizarDisponibilidad();
    } catch (ex) {
      manejarError("enviar la reservación", ex);
    }
  });
});

function renderReservas() {
  const cont = $("#lista-reservas");
  if (!state.cargado.reservas) return;
  const etiquetas = {
    pendiente: ["En revisión", "warning", "warning"],
    aprobada: ["Aprobada", "success", "success"],
    denegada: ["Denegada", "danger", "danger"],
    cancelada: ["Cancelada", "neutral", "muted"]
  };
  const lista = [...state.reservas].sort(
    (a, b) => `${b.fechaReserva}${b.horaInicio}`.localeCompare(`${a.fechaReserva}${a.horaInicio}`)
  );
  cont.innerHTML =
    lista
      .slice(0, 25)
      .map((r) => {
        const est = estatusReserva(r);
        const [txt, tipo, ic] = etiquetas[est];
        const nota = est === "denegada" ? r.motivoRechazo : r.notaAdmin;
        return `<li class="item">
          <span class="item__icon item__icon--${ic}">${icon("calendar")}</span>
          <div class="item__body">
            <div class="item__row">
              <span class="item__title">${esc(r.amenidad || "Amenidad")}</span>
              ${badge(txt, tipo)}
            </div>
            <span class="item__sub">${esc(fmtFechaLarga(toDate(r.fechaReserva)))} · ${esc(r.horaInicio || "")}–${esc(r.horaFin || "")}</span>
            ${nota ? `<p class="item__note"><strong>${est === "denegada" ? "Motivo" : "Nota"}:</strong> ${esc(nota)}</p>` : ""}
          </div>
        </li>`;
      })
      .join("") || vacio("No tienes reservaciones.", "calendar");
}

/* ---------------------------------------------------------------------
   13. REPORTES A ADMINISTRACIÓN (se guardan en `incidencias`)
   --------------------------------------------------------------------- */
const formRep = $("#form-reporte");

async function comprimirImagen(file, max = 1024, calidad = 0.72) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  const r = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * r);
  c.height = Math.round(img.height * r);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let url = c.toDataURL("image/jpeg", calidad);
  if (url.length > 800000) url = c.toDataURL("image/jpeg", 0.5);
  if (url.length > 900000) throw new Error("La imagen es demasiado pesada.");
  return url;
}

$("#input-foto").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    toast("Selecciona una imagen.", "warning");
    return;
  }
  try {
    state.fotoReporte = await comprimirImagen(file);
    $("#upload-preview").src = state.fotoReporte;
    $("#upload-preview").hidden = false;
    $("#upload-empty").hidden = true;
    $("#quitar-foto").hidden = false;
  } catch (err) {
    console.error(err);
    toast("No se pudo procesar la foto. Intenta con otra.", "error");
    quitarFoto();
  }
});

function quitarFoto() {
  state.fotoReporte = null;
  $("#input-foto").value = "";
  $("#upload-preview").hidden = true;
  $("#upload-preview").removeAttribute("src");
  $("#upload-empty").hidden = false;
  $("#quitar-foto").hidden = true;
}
$("#quitar-foto").addEventListener("click", quitarFoto);

formRep.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reporte-error");
  err.textContent = "";

  const categoria = formRep.categoria.value;
  const ubicacion = formRep.ubicacion.value.trim();
  const descripcion = formRep.descripcion.value.trim();

  if (ubicacion.length < 3) return (err.textContent = "Indica dónde ocurre el problema.");
  if (descripcion.length < 10) return (err.textContent = "Describe el problema con al menos 10 caracteres.");

  const data = {
    tipo: categoria,
    categoria,
    descripcion,
    ubicacion,
    casa: casaActual,
    casaId,
    residente: nombreResidente,
    rolReporta: perfil.rol,
    reportadoPor: `${nombreResidente} (${casaActual})`,
    origen: "residente",
    prioridad: categoria === "Seguridad" || categoria === "Fuga de agua" ? "alta" : "normal",
    estatus: "abierta",
    uidReporta: auth.currentUser?.uid || null,
    [CONFIG.campoFecha]: serverTimestamp()
  };
  if (state.fotoReporte) data.fotoUrl = state.fotoReporte;

  await conCarga($("#btn-reporte"), async () => {
    try {
      await addDoc(collection(db, COL.incidencias), data);
      formRep.reset();
      quitarFoto();
      alerta({
        tipo: "success",
        encabezado: "Reporte",
        titulo: "Reporte enviado",
        mensaje: "La administración ya puede verlo. Te mostraremos aquí cuando sea atendido."
      });
    } catch (ex) {
      manejarError("enviar el reporte", ex);
    }
  });
});

function renderReportes() {
  const cont = $("#lista-reportes");
  if (!state.cargado.reportes) return;
  cont.innerHTML =
    state.reportes
      .slice(0, 25)
      .map((r) => {
        const atendida = /atend|resuel|cerrad|solucion/.test(normalizar(pick(r, ["estatus", "estado"], "")));
        const foto = typeof r.fotoUrl === "string" && /^(https?:|data:image\/)/i.test(r.fotoUrl) ? r.fotoUrl : null;
        return `<li class="item">
          <span class="item__icon ${atendida ? "item__icon--success" : "item__icon--warning"}">${
            foto ? `<img src="${esc(foto)}" alt="" loading="lazy">` : icon("flag")
          }</span>
          <div class="item__body">
            <div class="item__row">
              <span class="item__title">${esc(pick(r, ["tipo", "categoria"], "Reporte"))}</span>
              ${atendida ? badge("Atendido", "success") : badge("En proceso", "warning")}
            </div>
            <span class="item__sub">${esc(r.ubicacion || "")}${r.ubicacion ? " · " : ""}${esc(hace(fechaDoc(r)))}</span>
            ${r.resolucion ? `<p class="item__note"><strong>Respuesta:</strong> ${esc(r.resolucion)}</p>` : ""}
          </div>
        </li>`;
      })
      .join("") || vacio("No has enviado reportes.", "flag");
}

/* ---------------------------------------------------------------------
   14. QR IDENTIFICADOR PERSONAL (estático con el número de casa)
   --------------------------------------------------------------------- */
const textoQRResidente = () => `${CONFIG.prefijoQR}|RESIDENTE|${casaId}|${perfil?.uid || ""}`;

function abrirMiQR() {
  abrirSheet(
    "Mi identificador",
    `<div class="sheet__center">
       <p class="sheet__big">${esc(casaActual)}</p>
       <p class="sheet__muted">${esc(nombreResidente)} · ${perfil?.rol === "inquilino" ? "Inquilino" : "Titular"}</p>
     </div>
     <div class="qr-box qr-box--lg" id="mi-qr"></div>
     <p class="note">${icon("alert")}Muéstralo en caseta si olvidaste tu tag. Sube el brillo de tu pantalla para una lectura más rápida.</p>
     <button type="button" class="btn btn--ghost btn--block" data-action="descargar-mi-qr">${icon("download")} Guardar en mi teléfono</button>`
  );
  pintarQR($("#mi-qr"), textoQRResidente());
}

/* ---------------------------------------------------------------------
   15. ACCIONES (delegación de eventos)
   --------------------------------------------------------------------- */
const ACCIONES = {
  "mi-qr": () => abrirMiQR(),
  "descargar-mi-qr": () => {
    const c = componerImagen($("#mi-qr"), "Identificador de residente", [casaActual, nombreResidente]);
    if (c) descargarCanvas(c, `QR_${casaActual.split(" · ")[0]}`);
  },
  expandir: (btn) => {
    const id = btn.dataset.id;
    state.expandidos.has(id) ? state.expandidos.delete(id) : state.expandidos.add(id);
    renderFeed();
  },
  votar: (btn) => votar(btn),
  "ver-pase": (btn) => verPase(btn.dataset.id),
  "cancelar-pase": (btn) => cancelarPase(btn.dataset.id, btn),
  "descargar-pase": (btn) => {
    const c = imagenPase(btn.dataset.target);
    if (c) descargarCanvas(c, `Pase_${state.paseActual.visitante}`);
  },
  "compartir-pase": (btn) => {
    const c = imagenPase(btn.dataset.target);
    if (c) compartirCanvas(c, `Pase_${state.paseActual.visitante}`, `Pase de acceso para ${state.paseActual.visitante} · ${casaActual}`);
  }
};

document.addEventListener("click", (e) => {
  const cerrar = e.target.closest("[data-close-sheet]");
  const ir = e.target.closest("[data-go]");
  const accion = e.target.closest("[data-action]");
  if (cerrar) cerrarSheet();
  if (ir) {
    irA(ir.dataset.go);
    return;
  }
  if (accion && !accion.disabled) ACCIONES[accion.dataset.action]?.(accion);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) cerrarSheet();
});

/* ---------------------------------------------------------------------
   16. LISTENERS EN TIEMPO REAL
   --------------------------------------------------------------------- */
function iniciarListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];

  state.unsubs.push(
    ...suscribirCasa(),

    onSnapshot(
      collection(db, COL.comunicados),
      (snap) => {
        state.comunicados = ordenarDesc(mapDocs(snap)).filter((c) => c.activo !== false);
        state.cargado.comunicados = true;
        renderFeed();
      },
      (err) => manejarError("las novedades", err)
    ),

    onSnapshot(
      query(collection(db, COL.pases), where("casaId", "==", casaId)),
      (snap) => {
        state.pases = ordenarDesc(mapDocs(snap));
        state.cargado.pases = true;
        renderPases();
      },
      (err) => manejarError("tus pases", err)
    ),

    onSnapshot(
      query(collection(db, COL.reservaciones), where("casaId", "==", casaId)),
      (snap) => {
        const previas = new Map(state.reservas.map((r) => [r.id, estatusReserva(r)]));
        state.reservas = mapDocs(snap);
        // Aviso cuando el admin aprueba o deniega
        if (state.cargado.reservas) {
          state.reservas.forEach((r) => {
            const antes = previas.get(r.id);
            const ahora = estatusReserva(r);
            if (antes === "pendiente" && ahora === "aprobada") toast(`¡Tu reservación de ${r.amenidad} fue aprobada!`, "success", 6000);
            if (antes === "pendiente" && ahora === "denegada") toast(`Tu reservación de ${r.amenidad} fue denegada.`, "error", 6000);
          });
        }
        state.cargado.reservas = true;
        renderReservas();
      },
      (err) => manejarError("tus reservaciones", err)
    ),

    onSnapshot(
      query(collection(db, COL.incidencias), where("casaId", "==", casaId)),
      (snap) => {
        state.reportes = ordenarDesc(mapDocs(snap)).filter((r) => r.origen === "residente");
        state.cargado.reportes = true;
        renderReportes();
      },
      (err) => manejarError("tus reportes", err)
    )
  );
}

/* ---------------------------------------------------------------------
   17. ARRANQUE
   --------------------------------------------------------------------- */
function saludo() {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}

function iniciales(nombre) {
  return String(nombre)
    .replace(/^(familia|fam\.?)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase() || "R";
}

function actualizarConexion() {
  $("#offline-bar").hidden = navigator.onLine;
}

function pintarEncabezado() {
  $("#saludo").textContent = `${saludo()}, ${nombreResidente}`;
  // Cada parte ("Casa 12", "Privada Roble", "Fase 2") se mantiene junta y el salto ocurre entre ellas
  $("#casa-label").innerHTML = casaActual
    .split(" · ")
    .map((parte) => `<span class="casa-seg">${esc(parte)}</span>`)
    .join(" · ");
  $("#rol-label").textContent = perfil?.rol === "inquilino" ? "Inquilino" : "Titular";
  $("#rol-label").className = `rol-chip rol-chip--${perfil?.rol === "inquilino" ? "inq" : "tit"}`;
  $("#avatar").textContent = iniciales(nombreResidente);
}

window.addEventListener("online", actualizarConexion);
window.addEventListener("offline", actualizarConexion);
actualizarConexion();

prepararFormPase();
prepararFormReserva();

// Refresca tiempos relativos y estados de pases cada minuto
setInterval(() => {
  if (!perfil) return;
  renderFeed();
  renderPases();
}, 60000);

/* ---------------------------------------------------------------------
   18. INICIO DE SESIÓN Y PERFIL
   --------------------------------------------------------------------- */
function pantalla(cual) {
  $("#boot").hidden = cual !== "boot";
  $("#login").hidden = cual !== "login";
  $("#app").hidden = cual !== "app";
}

function errorLogin(msg) {
  $("#login-error").textContent = msg;
}

/** Lee el perfil `usuarios/{uid}` y valida que la cuenta esté activa y vinculada a una casa. */
async function cargarPerfil(user) {
  const snap = await getDoc(doc(db, COL.usuarios, user.uid));
  if (!snap.exists()) throw new Error("Tu cuenta no está vinculada a ninguna casa. Contacta a la administración.");
  const p = { uid: user.uid, ...snap.data() };
  if (p.activo === false) throw new Error("Tu acceso fue desactivado por la administración.");
  if (!p.casaId) throw new Error("Tu cuenta no tiene una casa asignada. Contacta a la administración.");
  if (p.rol === "inquilino" && p.contratoHasta) {
    const fin = new Date(`${String(p.contratoHasta).slice(0, 10)}T23:59:59`);
    if (!isNaN(fin) && fin < new Date()) throw new Error("Tu contrato como inquilino terminó. Pide a la administración que lo renueve.");
  }
  return p;
}

function aplicarPermisos() {
  // Inquilino: sin historial de pagos ni votaciones
  $("#card-historial").hidden = !puede("historialPagos");
  $("#nota-historial").hidden = puede("historialPagos");
}

function limpiarSesion() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  Object.assign(state, {
    casa: null,
    casaLista: false,
    comunicados: [],
    pases: [],
    reservas: [],
    reportes: [],
    cargado: { comunicados: false, pases: false, reservas: false, reportes: false },
    paseActual: null
  });
  perfil = null;
  casaId = casaActual = nombreResidente = "";
  $("#pase-resultado").hidden = true;
  cerrarSheet();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    limpiarSesion();
    pantalla("login");
    return;
  }
  pantalla("boot");
  try {
    perfil = await cargarPerfil(user);
  } catch (err) {
    console.error(err);
    await signOut(auth);
    pantalla("login");
    errorLogin(err?.code === "permission-denied" ? "No se pudo leer tu perfil. Avisa a la administración." : err.message);
    return;
  }
  casaId = perfil.casaId;
  casaActual = perfil.casa || "Mi casa";
  nombreResidente = perfil.nombre || user.email;
  pintarEncabezado();
  aplicarPermisos();
  pantalla("app");
  irA(location.hash.replace("#", "") || "inicio");
  iniciarListeners();
});

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  errorLogin("");
  const email = $("#login-email").value.trim();
  const pass = $("#login-pass").value;
  if (!email || !pass) return errorLogin("Escribe tu correo y contraseña.");
  await conCarga($("#btn-login"), async () => {
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (err) {
      const mapa = {
        "auth/invalid-credential": "Correo o contraseña incorrectos.",
        "auth/wrong-password": "Correo o contraseña incorrectos.",
        "auth/user-not-found": "Correo o contraseña incorrectos.",
        "auth/invalid-email": "El correo no es válido.",
        "auth/user-disabled": "Esta cuenta está deshabilitada.",
        "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
        "auth/network-request-failed": "Sin conexión a internet."
      };
      errorLogin(mapa[err.code] || "No fue posible iniciar sesión.");
    }
  });
});

$("#btn-olvide").addEventListener("click", async () => {
  const email = $("#login-email").value.trim();
  if (!email) return errorLogin("Escribe tu correo y vuelve a tocar «¿Olvidaste tu contraseña?».");
  try {
    await sendPasswordResetEmail(auth, email);
    errorLogin("");
    toast(`Si ${email} está registrado, recibirás un correo para crear una nueva contraseña.`, "success", 7000);
  } catch (err) {
    errorLogin(err.code === "auth/invalid-email" ? "El correo no es válido." : "No se pudo enviar el correo. Intenta más tarde.");
  }
});

function abrirPerfil() {
  if (!perfil) return;
  const filas = [
    ["Nombre", perfil.nombre],
    ["Perfil", perfil.rol === "inquilino" ? "Inquilino" : "Titular"],
    ["Casa", casaActual],
    ["Correo", perfil.email || auth.currentUser?.email],
    perfil.telefono ? ["Teléfono", perfil.telefono] : null,
    perfil.rol === "inquilino" && perfil.contratoHasta ? ["Contrato hasta", fmtFechaLarga(toDate(String(perfil.contratoHasta).slice(0, 10)))] : null
  ].filter(Boolean);

  abrirSheet(
    "Mi perfil",
    `<dl class="pass__info">${filas.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v || "—")}</dd></div>`).join("")}</dl>
     <form class="form" id="form-password" novalidate>
       <p class="section-title">Cambiar contraseña</p>
       <label class="field"><span class="field__label">Contraseña actual</span>
         <input type="password" name="actual" required autocomplete="current-password"></label>
       <label class="field"><span class="field__label">Nueva contraseña (mínimo 8 caracteres)</span>
         <input type="password" name="nueva" required minlength="8" autocomplete="new-password"></label>
       <p class="form-error" id="password-error" role="alert"></p>
       <button type="submit" class="btn btn--primary btn--block" id="btn-password">Actualizar contraseña</button>
     </form>
     <button type="button" class="btn btn--danger-ghost btn--block" data-action="salir">Cerrar sesión</button>`
  );
}

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "form-password") return;
  e.preventDefault();
  const f = e.target;
  const err = $("#password-error");
  err.textContent = "";
  const actual = f.actual.value;
  const nueva = f.nueva.value;
  if (!actual) return (err.textContent = "Escribe tu contraseña actual.");
  if (nueva.length < 8) return (err.textContent = "La nueva contraseña debe tener al menos 8 caracteres.");
  if (nueva === actual) return (err.textContent = "La nueva contraseña debe ser distinta a la actual.");
  await conCarga($("#btn-password"), async () => {
    try {
      const user = auth.currentUser;
      // Firebase exige confirmar la contraseña actual antes de cambiarla
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, actual));
      await updatePassword(user, nueva);
      cerrarSheet();
      toast("Contraseña actualizada", "success");
    } catch (ex) {
      err.textContent =
        ex.code === "auth/invalid-credential" || ex.code === "auth/wrong-password"
          ? "La contraseña actual no es correcta."
          : ex.code === "auth/weak-password"
            ? "La nueva contraseña es muy débil."
            : "No se pudo cambiar la contraseña. Intenta de nuevo.";
    }
  });
});

ACCIONES.perfil = () => abrirPerfil();
ACCIONES.salir = async () => {
  if (!confirm("¿Cerrar sesión en este dispositivo?")) return;
  cerrarSheet();
  await signOut(auth);
};