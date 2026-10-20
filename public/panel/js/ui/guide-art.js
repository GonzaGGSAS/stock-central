// Dibujitos de la guía: SVG en línea, trazo simple, solo con los 4 colores del panel
// (neutro, verde, ámbar, rojo). Los colores salen de clases CSS (.gs-*, .gf-*, .gt-*) que usan los tokens.
import { html } from '../../vendor/htm-preact-3.1.1.js';

// ─── Formas base (cada una entra en una caja de ~48×48) ──────────────────────
const TEE = 'M16 4 L4 11 L9 21 L14 18.5 V44 H34 V18.5 L39 21 L44 11 L32 4 C29 9.5 19 9.5 16 4 Z';
const HOOD = 'M17 8 L6 14 L3 40 H10 L13 23 V46 H35 V23 L38 40 H45 L42 14 L31 8 C30 1 18 1 17 8 Z';
const HOOD_IN = 'M19 9 C21 15 27 15 29 9 M18 35 H30 V41 H18 Z';
const PANTS = 'M12 4 H36 L40 46 H28 L24 18 L20 46 H8 Z M12 10 H36';
const BOX = 'M4 16 L24 6 L44 16 V38 L24 48 L4 38 Z M4 16 L24 26 L44 16 M24 26 V48';
const SHOP = 'M5 18 L10 6 H38 L43 18 Z M8 18 V44 H40 V18 M20 44 V31 H28 V44 M12 24 H17 V30 H12 Z';
const CART = 'M2 6 H9 L14 32 H40 L45 13 H11';
const TICKET = 'M8 4 H40 V44 L36 40 L32 44 L28 40 L24 44 L20 40 L16 44 L12 40 L8 44 Z';
const TICKET_IN = 'M14 14 H34 M14 22 H34 M14 30 H26';
const BELL = 'M24 6 C15 6 12 13 12 21 V29 L7 35 H41 L36 29 V21 C36 13 33 6 24 6 Z M20 39 C20 43 28 43 28 39';
const BELL_RING = 'M7 13 L3 10 M41 13 L45 10 M5 22 H1 M43 22 H47';
const LOCK = 'M10 22 H38 V44 H10 Z M16 22 V15 C16 5 32 5 32 15 V22 M24 30 V36';
const SCREEN = 'M4 4 H52 V40 H4 Z M20 48 H36 M28 40 V48';
const HOURGLASS = 'M14 4 H34 M14 44 H34 M16 4 C16 16 32 20 32 24 C32 28 16 32 16 44 M32 4 C32 16 16 20 16 24 C16 28 32 32 32 44';

const at = (x, y, s = 1) => `translate(${x} ${y})${s !== 1 ? ` scale(${s})` : ''}`;
const shape = (d, x, y, s, tone = 'n', fill) => html`<g transform=${at(x, y, s)}>
  <path d=${d} class=${'gs gs-' + tone + (fill ? ' gf-' + fill : '')} /></g>`;
const txt = (x, y, t, size = 18, tone = 'n') => html`<text x=${x} y=${y} class=${'gt gt-' + tone} font-size=${size} text-anchor="middle">${t}</text>`;
const arrow = (x1, y1, x2, y2, tone = 'n', dashed) => {
  const a = Math.atan2(y2 - y1, x2 - x1), h = 7;
  const p1 = [x2 - h * Math.cos(a - 0.5), y2 - h * Math.sin(a - 0.5)];
  const p2 = [x2 - h * Math.cos(a + 0.5), y2 - h * Math.sin(a + 0.5)];
  return html`<path d=${`M${x1} ${y1} L${x2} ${y2} M${p1[0].toFixed(1)} ${p1[1].toFixed(1)} L${x2} ${y2} L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`}
    class=${'gs gs-' + tone + (dashed ? ' gs-dash' : '')} />`;
};
const clock = (cx, cy, r, tone = 'warn') => html`<circle cx=${cx} cy=${cy} r=${r} class=${'gs gs-' + tone + ' gf-' + tone} />
  <path d=${`M${cx} ${cy - r + 5} V${cy} L${cx + r * 0.45} ${cy + r * 0.3}`} class=${'gs gs-' + tone} />`;
const badge = (cx, cy, r, tone, t, size = 13) => html`<circle cx=${cx} cy=${cy} r=${r} class=${'gfs-' + tone} />
  <text x=${cx} y=${cy + size * 0.36} class="gt gt-ink" font-size=${size} text-anchor="middle">${t}</text>`;

// ─── Dibujos ─────────────────────────────────────────────────────────────────
const ART = {
  // Stock Central manda: el número del panel pasa solo a la tienda.
  manda: () => html`
    ${shape(SCREEN, 6, 20, 1, 'n', 'n')}
    ${txt(34, 52, '5', 26, 'ok')}
    ${arrow(68, 42, 96, 42, 'ok')}
    <path d="M74 30 C80 24 88 24 92 30" class="gs gs-ok gs-dash" />
    ${shape(SHOP, 104, 18, 1.05)}
    ${txt(129, 16, '5', 14, 'ok')}`,

  // Disponible: una remera con un 2 grande.
  disponible: () => html`
    ${shape(TEE, 37, 6, 1.8, 'ok', 'ok')}
    ${txt(80, 68, '2', 32, 'ok')}`,

  // Físico: la caja del depósito con lo que hay adentro.
  fisico: () => html`
    ${shape(BOX, 22, 10, 1.6, 'n', 'n')}
    ${txt(122, 58, '3', 34, 'n')}
    ${txt(122, 80, 'en la caja', 11, 'muted')}`,

  // Reservado: un carrito con un reloj de 15 minutos.
  reservado: () => html`
    ${shape(CART, 8, 18, 1.6, 'warn')}
    <circle cx="35" cy="83" r="4" class="gs gs-warn" /><circle cx="67" cy="83" r="4" class="gs gs-warn" />
    ${shape(TEE, 34, 30, 0.72, 'warn', 'warn')}
    ${clock(126, 42, 22)}
    ${txt(126, 82, '15 min', 12, 'warn')}`,

  // Stock compartido: dos remeras distintas salen de la misma caja.
  compartido: () => html`
    ${shape(BOX, 56, 42, 1)}
    ${shape(TEE, 4, 2, 1)}
    <circle cx="28" cy="30" r="4" class="gs gs-n" />
    ${shape(TEE, 108, 2, 1)}
    <path d="M127 26 L137 36 M137 26 L127 36" class="gs gs-n" />
    ${arrow(70, 50, 48, 40, 'ok', true)}
    ${arrow(90, 50, 112, 40, 'ok', true)}`,

  // Queda 1: si un diseño la tiene en el carrito, el otro se ve sin stock.
  ultima: () => html`
    ${shape(BOX, 56, 46, 0.95)}
    ${txt(80, 42, '1', 16, 'n')}
    ${shape(TEE, 4, 4, 1, 'warn', 'warn')}
    ${txt(28, 38, '1', 14, 'warn')}
    ${shape(TEE, 108, 4, 1, 'bad', 'bad')}
    ${txt(132, 38, '0', 14, 'bad')}
    ${arrow(68, 58, 46, 50, 'warn', true)}
    ${arrow(92, 58, 114, 50, 'bad', true)}`,

  // Botones +1 / −1.
  masmenos: () => html`
    <rect x="10" y="24" width="56" height="44" rx="10" class="gs gs-n gf-n" />
    ${txt(38, 54, '−1', 22, 'n')}
    <rect x="94" y="24" width="56" height="44" rx="10" class="gs gs-ok gf-ok" />
    ${txt(122, 54, '+1', 22, 'ok')}
    ${txt(80, 52, 'o', 13, 'muted')}`,

  // Alertas: una campana roja.
  campana: () => html`
    ${shape(BELL, 42, 8, 1.6, 'bad', 'bad')}
    ${shape(BELL_RING, 42, 8, 1.6, 'bad')}
    ${badge(116, 20, 11, 'bad', '!', 15)}`,

  // Combos: dos buzos unidos.
  combo: () => html`
    ${shape(HOOD, 12, 6, 1.3)}${shape(HOOD_IN, 12, 6, 1.3)}
    ${shape(HOOD, 86, 6, 1.3)}${shape(HOOD_IN, 86, 6, 1.3)}
    ${txt(80, 46, '+', 22, 'ok')}
    <path d="M28 82 V88 H132 V82" class="gs gs-ok" />`,

  // El combo tiene el stock del que menos tiene: 5 y 2 → 2.
  menor: () => html`
    ${shape(HOOD, 0, 8, 0.9)}
    ${txt(22, 78, '5', 18, 'n')}
    ${txt(48, 40, '+', 18, 'muted')}
    ${shape(PANTS, 54, 8, 0.9)}
    ${txt(76, 78, '2', 18, 'n')}
    ${txt(104, 42, '=', 20, 'muted')}
    <circle cx="136" cy="36" r="19" class="gs gs-warn gf-warn" />
    ${txt(136, 44, '2', 22, 'warn')}
    ${txt(136, 78, 'combo', 11, 'warn')}`,

  // NO cambiar el número en la tienda.
  notienda: () => html`
    ${shape(SHOP, 18, 16, 1.4)}
    <circle cx="124" cy="42" r="22" class="gs gs-bad gf-bad" />
    <path d="M108.5 26.5 L139.5 57.5" class="gs gs-bad" />
    <path d="M114 50 L128 36 L132 40 L118 54 Z" class="gs gs-bad" />`,

  // Vincular: la prenda de acá conectada con el producto de la tienda.
  vincular: () => html`
    ${shape(TEE, 2, 22, 1.1)}
    <ellipse cx="72" cy="48" rx="13" ry="8" class="gs gs-ok" />
    <ellipse cx="88" cy="48" rx="13" ry="8" class="gs gs-ok" />
    ${shape(SHOP, 104, 20, 1.1)}`,

  // Venta: entra el pedido y se descuenta solo.
  pedido: () => html`
    ${shape(TICKET, 2, 18, 1.2)}${shape(TICKET_IN, 2, 18, 1.2)}
    ${arrow(66, 46, 94, 46, 'ok')}
    ${shape(TEE, 100, 22, 1.05)}
    ${badge(146, 22, 12, 'ok', '−1', 11)}`,

  // Pedido cancelado: vuelve solo al stock.
  vuelve: () => html`
    ${shape(TICKET, 2, 18, 1.2, 'bad')}
    <path d="M18 32 L46 60 M46 32 L18 60" class="gs gs-bad" />
    <path d="M68 58 C78 30 98 30 106 52" class="gs gs-ok gs-dash" />
    ${arrow(100, 46, 106, 54, 'ok')}
    ${shape(BOX, 106, 34, 1)}
    ${badge(146, 26, 12, 'ok', '+1', 11)}`,

  // Actividad: el diario, una tarjeta debajo de otra.
  diario: () => html`
    <rect x="14" y="8" width="132" height="22" rx="5" class="gs gs-n gf-n" /><path d="M15 9 V29" class="gs gs-ok gs-thick" />
    <path d="M24 19 H90" class="gs gs-n" />${txt(130, 24, '−1', 13, 'n')}
    <rect x="14" y="38" width="132" height="22" rx="5" class="gs gs-n gf-n" /><path d="M15 39 V59" class="gs gs-warn gs-thick" />
    <path d="M24 49 H76" class="gs gs-n" />
    <rect x="14" y="68" width="132" height="22" rx="5" class="gs gs-n gf-n" /><path d="M15 69 V89" class="gs gs-bad gs-thick" />
    <path d="M24 79 H100" class="gs gs-n" />`,

  // Clave de administrador: un candado.
  candado: () => html`
    ${shape(LOCK, 42, 4, 1.6, 'n', 'n')}
    ${txt(132, 40, '•••', 18, 'muted')}
    ${txt(132, 60, 'solo vos', 11, 'muted')}`,

  // Mantenimiento: tareas largas que corren solas.
  tareas: () => html`
    ${shape(HOURGLASS, 58, 2, 0.95, 'warn')}
    <rect x="20" y="66" width="120" height="12" rx="6" class="gs gs-n gf-n" />
    <rect x="20" y="66" width="70" height="12" rx="6" class="gfs-warn" />`,

  // Ajustes: el panel y la tienda conectados (puntitos verdes).
  conectado: () => html`
    ${shape(SCREEN, 4, 22, 0.9, 'n', 'n')}
    <path d="M58 44 H102" class="gs gs-ok gs-dash" />
    <circle cx="80" cy="44" r="11" class="gs gs-ok gf-ok" />
    <path d="M75 44 L79 48 L86 40" class="gs gs-ok" />
    ${shape(SHOP, 106, 20, 1.05)}`,
};

export const ART_NAMES = Object.keys(ART);

/** <Art name="disponible" label="…" small /> */
export function Art({ name, label, small }) {
  const draw = ART[name];
  if (!draw) return null;
  return html`<svg class=${'gart' + (small ? ' gart-sm' : '')} viewBox="0 0 160 96" role="img" aria-label=${label}
    focusable="false" xmlns="http://www.w3.org/2000/svg">${draw()}</svg>`;
}
