// Piezas de UI reutilizables: botones con estado, errores en el lugar, skeletons, progreso.
import { html, useState, useRef, useEffect, useCallback } from '../../vendor/htm-preact-3.1.1.js';
import { Icon } from './icons.js';

export const cx = (...a) => a.filter(Boolean).join(' ');

export function Spinner({ size = 16, label }) {
  return html`<span class="spinner" style=${`width:${size}px;height:${size}px`} role=${label ? 'status' : undefined}
    aria-label=${label || undefined} aria-hidden=${label ? undefined : 'true'}></span>`;
}

/**
 * Botón con estado de carga. Si onClick devuelve una promesa, se pone "cargando" y
 * se deshabilita solo hasta que termina.
 */
export function Button({ kind = 'default', size, loading, disabled, onClick, icon, children, type = 'button', title, label, class: cls, busyText, ...rest }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const isBusy = loading || busy;
  const handle = async (e) => {
    if (!onClick || isBusy) return;
    const r = onClick(e);
    if (r && typeof r.then === 'function') {
      setBusy(true);
      try { await r; } catch { /* el que llama maneja el error */ } finally { if (alive.current) setBusy(false); }
    }
  };
  return html`<button type=${type} class=${cx('btn', 'btn-' + kind, size && 'btn-' + size, !children && 'btn-icon', cls)}
    disabled=${disabled || isBusy} aria-busy=${isBusy ? 'true' : undefined} onClick=${handle}
    title=${title} aria-label=${label} ...${rest}>
    ${isBusy ? html`<${Spinner} size=${14} />` : icon ? html`<${Icon} name=${icon} size=${16} />` : null}
    ${children ? html`<span>${isBusy && busyText ? busyText : children}</span>` : null}
  </button>`;
}

/**
 * Acción asíncrona con error guardado para mostrarlo en el lugar.
 * const [run, st] = useAction(async (x) => ...); st.loading · st.error · st.reset()
 */
export function useAction(fn) {
  const [st, setSt] = useState({ loading: false, error: null, data: undefined });
  const fnRef = useRef(fn); fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async (...args) => {
    setSt(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current(...args);
      if (alive.current) setSt({ loading: false, error: null, data });
      return data;
    } catch (error) {
      if (alive.current) setSt(s => ({ ...s, loading: false, error }));
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setSt({ loading: false, error: null, data: undefined }), []);
  return [run, { ...st, reset }];
}

/** Error en el lugar donde ocurrió, con el mensaje concreto del backend y "Reintentar". */
export function ErrorBox({ error, onRetry, title, compact, onClose }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message || 'Error desconocido';
  const meta = typeof error === 'object' && (error.status ? `HTTP ${error.status}` : error.network ? 'sin conexión' : '');
  return html`<div class=${cx('errbox', compact && 'errbox-compact')} role="alert">
    <${Icon} name="alert" size=${compact ? 16 : 18} />
    <div class="errbox-body">
      ${title ? html`<strong>${title}</strong>` : null}
      <span class="errbox-msg">${msg}</span>
      ${meta && !compact ? html`<span class="muted small">${meta}</span>` : null}
    </div>
    ${onRetry ? html`<${Button} size="sm" icon="refresh" onClick=${onRetry}>Reintentar</${Button}>` : null}
    ${onClose ? html`<${Button} size="sm" kind="ghost" icon="x" label="Cerrar" onClick=${onClose} />` : null}
  </div>`;
}

/** Error al revalidar algo que ya se ve (los datos viejos quedan en pantalla). */
export function StaleError({ r }) {
  if (!r?.error || r.data === undefined) return null;
  return html`<${ErrorBox} compact error=${'No se pudo actualizar: ' + (r.error.message || r.error)} onRetry=${r.reload} />`;
}

export function Skeleton({ h = 14, w = '100%', r = 6, class: cls }) {
  return html`<span class=${cx('skel', cls)} style=${`height:${typeof h === 'number' ? h + 'px' : h};width:${typeof w === 'number' ? w + 'px' : w};border-radius:${r}px`} aria-hidden="true"></span>`;
}

export function SkeletonRows({ rows = 4, h = 44 }) {
  return html`<div class="skel-rows" aria-busy="true" aria-label="Cargando">
    ${Array.from({ length: rows }, (_, i) => html`<${Skeleton} key=${i} h=${h} r=${8} />`)}
  </div>`;
}

export function Empty({ icon = 'info', title, children }) {
  return html`<div class="empty">
    <${Icon} name=${icon} size=${22} />
    <strong>${title}</strong>
    ${children ? html`<div class="muted">${children}</div>` : null}
  </div>`;
}

/** Barra de progreso. Sin total → indeterminada. */
export function Progress({ current = 0, total = 0, tone = '', label, small }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
  return html`<div class=${cx('progress', tone && 'tone-' + tone, small && 'progress-sm', pct == null && 'progress-indet')}
    role="progressbar" aria-valuemin="0" aria-valuemax=${total || undefined} aria-valuenow=${pct == null ? undefined : current}
    aria-label=${label || 'Progreso'}>
    <span style=${pct == null ? '' : `width:${pct}%`}></span>
  </div>`;
}

export function Chip({ active, onClick, children, count, tone }) {
  return html`<button type="button" class=${cx('chip', active && 'chip-on', tone && 'tone-' + tone)} aria-pressed=${active ? 'true' : 'false'} onClick=${onClick}>
    <span>${children}</span>${count != null ? html`<span class="chip-count">${count}</span>` : null}
  </button>`;
}

export function Pill({ tone = '', children, title }) {
  return html`<span class=${cx('pill', tone && 'tone-' + tone)} title=${title}>${children}</span>`;
}

export function Field({ label, hint, children, error }) {
  return html`<label class="field">
    <span class="field-label">${label}</span>
    ${children}
    ${hint ? html`<span class="field-hint">${hint}</span>` : null}
    ${error ? html`<span class="field-err">${error}</span>` : null}
  </label>`;
}

/** Indicador chiquito "actualizando" para revalidaciones en segundo plano. */
export function Refreshing({ on }) {
  return html`<span class=${cx('refreshing', on && 'on')} aria-live="polite">${on ? html`<${Spinner} size=${12} /><span>Actualizando…</span>` : null}</span>`;
}

/** Contador de segundos para cargas lentas ("hace 8 s"). */
export function useElapsed(active) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!active) { setS(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setS(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return s;
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Menú desplegable simple (botón ⋯). items: [{label, icon, onClick, danger}] */
export function Menu({ items, label = 'Más acciones' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return html`<div class="menu" ref=${ref}>
    <button type="button" class="btn btn-ghost btn-icon" aria-haspopup="true" aria-expanded=${open ? 'true' : 'false'}
      aria-label=${label} title=${label} onClick=${() => setOpen(o => !o)}><${Icon} name="more" /></button>
    ${open ? html`<div class="menu-list" role="menu">
      ${items.filter(Boolean).map((it) => html`<button type="button" role="menuitem" class=${cx('menu-item', it.danger && 'tone-bad')}
        onClick=${() => { setOpen(false); it.onClick(); }}>
        ${it.icon ? html`<${Icon} name=${it.icon} size=${16} />` : null}<span>${it.label}</span></button>`)}
    </div>` : null}
  </div>`;
}
