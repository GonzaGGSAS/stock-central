// Shell del panel: encabezado con logo, navegación, estado de conexión y vistas.
import { html, render, useEffect, useState, useRef } from '../vendor/htm-preact-3.1.1.js';
import { api, onApi, ping, getToken } from './lib/api.js';
import { createStore, useStore, invalidate, useCached } from './lib/store.js';
import { route, useRoute, href } from './lib/router.js';
import { startLive, liveStatus, restartLive } from './lib/live.js';
import { jobsStore, runningJobs, pokeJob } from './lib/jobs.js';
import { storeInfo, DEFAULT_LOGO } from './lib/store-info.js';
import { Icon } from './ui/icons.js';
import { cx } from './ui/components.js';
import { ToastHost, ConfirmHost } from './ui/overlay.js';
import { GuidePanel, GuideToggle, useGuideColumn, guideIdFor } from './ui/guide.js';
import { Inicio } from './views/inicio.js';
import { Stock } from './views/stock.js';
import { Combos } from './views/combos.js';
import { Actividad } from './views/actividad.js';
import { Ajustes } from './views/ajustes.js';
import { Login } from './views/login.js';

const auth = createStore({ needed: false });
const net = createStore({ online: true });

// ─── Conexión y auth ─────────────────────────────────────────────────────────
onApi('auth', () => auth.set({ needed: true }));
let reconnectTimer = null;
onApi('net', (ok) => {
  if (ok) {
    if (!net.get().online) { net.set({ online: true }); invalidate(SAFE_ALL, { delay: 0 }); }
    return;
  }
  if (net.get().online) net.set({ online: false });
  if (reconnectTimer) return;
  const loop = async (n) => {
    const up = await ping();
    if (up) { reconnectTimer = null; net.set({ online: true }); invalidate(SAFE_ALL, { delay: 0 }); restartLive(); return; }
    reconnectTimer = setTimeout(() => loop(n + 1), Math.min(15000, 3000 + n * 1500));
  };
  reconnectTimer = setTimeout(() => loop(0), 1500);
});

// Lo lento o que pega a Tiendanube no se refresca en automático.
const NO_AUTO = new Set(['tn-products', 'health', 'config']);
const SAFE_ALL = (k) => !NO_AUTO.has(k);

function onLive(ev) {
  switch (ev.topic) {
    case '*': invalidate(SAFE_ALL); break;
    case 'stock':
      invalidate('productos'); invalidate('overview');
      invalidate(ev.productoId ? 'log:' + ev.productoId : 'log');
      break;
    case 'activity': invalidate('activity'); invalidate('overview'); invalidate('log'); break;
    case 'alerts': invalidate('alerts'); invalidate('overview'); break;
    case 'jobs': if (ev.jobId) pokeJob(ev.jobId); invalidate('jobs'); invalidate('overview'); break;
    case 'matchs': invalidate('matchs'); break;
    default: break;
  }
}

// ─── Logo: detecta si es oscuro y lo invierte para que se vea sobre fondo oscuro ──
function useLogoTone(src) {
  const cacheKey = 'sc_logo_tone:' + src;
  const [tone, setTone] = useState(() => { try { return localStorage.getItem(cacheKey) || ''; } catch { return ''; } });
  const analyze = (img) => {
    try {
      const c = document.createElement('canvas');
      const w = c.width = 64, h = c.height = Math.max(8, Math.round(64 * (img.naturalHeight / img.naturalWidth || 0.3)));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0, n = 0, opaqueLight = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a < 0.3) continue;
        const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        sum += l; n++; if (l > 0.85) opaqueLight++;
      }
      // Logo con fondo blanco opaco (casi todo claro y sin transparencia) → lo dejamos sobre "chip" claro.
      const t = !n ? 'light' : (opaqueLight / n > 0.7 && n > (w * h) * 0.9) ? 'chip' : sum / n < 0.5 ? 'dark' : 'light';
      setTone(t);
      try { localStorage.setItem(cacheKey, t); } catch { /* */ }
    } catch { setTone('chip'); }
  };
  return [tone, analyze];
}

export function Logo({ small }) {
  const info = useStore(storeInfo);
  const [src, setSrc] = useState(info.logo_url || DEFAULT_LOGO);
  const [cors, setCors] = useState(true);
  useEffect(() => { setSrc(info.logo_url || DEFAULT_LOGO); setCors(true); }, [info.logo_url]);
  const [tone, analyze] = useLogoTone(src);
  const onError = () => {
    if (cors) { setCors(false); return; } // sin CORS: se muestra igual, sobre chip claro
    if (src !== DEFAULT_LOGO) setSrc(DEFAULT_LOGO);
  };
  return html`<span class=${cx('logo', small && 'logo-sm', (!cors || tone === 'chip') && 'logo-chip', tone === 'dark' && cors && 'logo-invert')}>
    <img src=${src} alt=${info.name || 'Minch'} crossorigin=${cors ? 'anonymous' : undefined} decoding="async"
      onLoad=${(e) => { if (cors) analyze(e.currentTarget); }} onError=${onError} />
  </span>`;
}

// ─── Encabezado ──────────────────────────────────────────────────────────────
function LiveDot() {
  const s = useStore(liveStatus);
  const n = useStore(net);
  const [mode, text, title] = !n.online ? ['bad', 'Sin conexión', 'No hay conexión con el servidor']
    : s.mode === 'live' ? ['ok', 'En vivo', 'Los cambios aparecen solos']
      : s.mode === 'polling' ? ['warn', 'Cada 20 s', 'Sin conexión en vivo: se actualiza cada 20 segundos']
        : ['n', 'Conectando…', 'Conectando en vivo'];
  return html`<span class=${'live live-' + mode} title=${title} role="status" aria-label=${title}><span class=${'dot dot-' + mode}></span><span class="live-t">${text}</span></span>`;
}

function JobsPill() {
  const jobs = useStore(jobsStore, runningJobs);
  if (!jobs.length) return null;
  const j = jobs[0];
  const pct = j.progress?.total ? Math.round((j.progress.current / j.progress.total) * 100) : null;
  return html`<a class="jobs-pill" href=${href('ajustes')} title=${`${j.label}${pct != null ? ` · ${pct}%` : ''}`}>
    <span class="spinner" style="width:12px;height:12px"></span>
    <span class="jobs-pill-t">${jobs.length > 1 ? `${jobs.length} tareas` : j.label}${pct != null ? ` · ${pct}%` : ''}</span>
  </a>`;
}

const NAV = [
  { id: 'inicio', label: 'Inicio', icon: 'home' },
  { id: 'stock', label: 'Stock', icon: 'box' },
  { id: 'combos', label: 'Combos', icon: 'layers' },
  { id: 'actividad', label: 'Actividad', icon: 'activity' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings' },
];

function Nav({ view, alerts }) {
  return html`<nav class="nav" aria-label="Secciones">
    ${NAV.map(n => html`<a key=${n.id} href=${href(n.id)} class=${cx('nav-a', view === n.id && 'nav-on')} aria-current=${view === n.id ? 'page' : undefined}>
      <${Icon} name=${n.icon} size=${20} />
      <span>${n.label}</span>
      ${n.id === 'inicio' && alerts > 0 ? html`<span class="nav-badge" aria-label=${`${alerts} alertas`}>${alerts > 99 ? '99+' : alerts}</span>` : null}
    </a>`)}
  </nav>`;
}

function BusyBar() {
  const [on, setOn] = useState(false);
  const t = useRef(null);
  useEffect(() => onApi('busy', (n) => {
    clearTimeout(t.current);
    if (n > 0) t.current = setTimeout(() => setOn(true), 180);
    else setOn(false);
  }), []);
  return html`<div class=${cx('busybar', on && 'on')} aria-hidden="true"><span></span></div>`;
}

function OfflineBanner() {
  const n = useStore(net);
  if (n.online) return null;
  return html`<div class="offline" role="alert"><${Icon} name="wifiOff" size=${16} /><span>Sin conexión con el servidor — reintentando…</span><span class="spinner" style="width:12px;height:12px"></span></div>`;
}

// ─── App ─────────────────────────────────────────────────────────────────────
function App() {
  const r = useRoute();
  const a = useStore(auth);
  const info = useStore(storeInfo);
  const ov = useCached('overview');
  const alertList = useCached('alerts');
  const alerts = Array.isArray(alertList) ? alertList.filter(x => !x.dismissed).length : ov?.alerts_open ?? 0;
  const guideCol = useGuideColumn();

  useEffect(() => { document.title = `Stock Central · ${info.name || 'Minch'}`; }, [info.name]);
  useEffect(() => { window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); }, [r.view]);

  if (a.needed) {
    return html`<${Login} Logo=${Logo} onDone=${() => { auth.set({ needed: false }); restartLive(); invalidate(SAFE_ALL, { delay: 0 }); }} />
      <${ToastHost} />`;
  }
  const View = { inicio: Inicio, stock: Stock, combos: Combos, actividad: Actividad, ajustes: Ajustes }[r.view] || Inicio;
  return html`
    <a class="skip" href="#main">Saltar al contenido</a>
    <${BusyBar} />
    <header class="top">
      <div class="top-in">
        <a class="brand" href=${href('inicio')} aria-label="Inicio">
          <${Logo} />
          <span class="brand-t">Stock Central</span>
        </a>
        <${Nav} view=${r.view} alerts=${alerts} />
        <div class="top-right"><${JobsPill} /><${LiveDot} /><${GuideToggle} /></div>
      </div>
    </header>
    <${OfflineBanner} />
    <main id="main" class=${cx('main', guideCol && 'main-guide')} tabindex="-1">
      <${View} key=${r.view} query=${r.query} />
      <${GuidePanel} key=${'g-' + r.view} id=${guideIdFor(r.view)} />
    </main>
    <${ToastHost} />
    <${ConfirmHost} />`;
}

// ─── Arranque ────────────────────────────────────────────────────────────────
async function boot() {
  const root = document.getElementById('app');
  root.textContent = '';
  render(html`<${App} />`, root);
  // ¿El server pide token? (si /api/health no existe todavía, seguimos y esperamos un 401).
  try {
    const h = await api('/api/health', { timeout: 8000 });
    if (h?.auth_required && !getToken()) auth.set({ needed: true });
  } catch { /* 404 o sin conexión: lo maneja cada vista */ }
  startLive(onLive);
}
boot();
