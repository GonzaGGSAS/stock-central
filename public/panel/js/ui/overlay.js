// Toasts, modales/drawers y confirmaciones.
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact-3.1.1.js';
import { createStore, useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { Button, cx } from './components.js';

// ─── Toasts ──────────────────────────────────────────────────────────────────
const toasts = createStore([]);
let tid = 0;
/** toast('Guardado') · toast('Falló X', { tone: 'bad' }) */
export function toast(msg, { tone = 'ok', timeout } = {}) {
  const id = ++tid;
  toasts.set(list => [...list.slice(-3), { id, msg, tone }]);
  const ms = timeout ?? (tone === 'bad' ? 8000 : 4000);
  setTimeout(() => dismissToast(id), ms);
  return id;
}
export const dismissToast = (id) => toasts.set(list => list.filter(t => t.id !== id));

export function ToastHost() {
  const list = useStore(toasts);
  return html`<div class="toasts" aria-live="polite" aria-atomic="false">
    ${list.map(t => html`<div key=${t.id} class=${cx('toast', 'tone-' + t.tone)} role=${t.tone === 'bad' ? 'alert' : 'status'}>
      <${Icon} name=${t.tone === 'bad' ? 'alert' : t.tone === 'warn' ? 'info' : 'check'} size=${16} />
      <span>${t.msg}</span>
      <button type="button" class="toast-x" aria-label="Cerrar aviso" onClick=${() => dismissToast(t.id)}><${Icon} name="x" size=${14} /></button>
    </div>`)}
  </div>`;
}

// ─── Modal / Drawer ──────────────────────────────────────────────────────────
let openCount = 0;
/**
 * <Modal title onClose side? footer?>…</Modal>
 * side=true → panel lateral (en el celular, hoja desde abajo).
 * aside → algo que va al costado del panel lateral (la guía), dentro del mismo fondo oscuro.
 *   asideVisible=true cuando se ve como columna: el diálogo deja de ser aria-modal para que
 *   un lector de pantalla también la lea (el foco igual queda atrapado entre los dos).
 * headExtra → botones extra en el encabezado, al lado de la X.
 */
export function Modal({ title, subtitle, onClose, children, footer, side, wide, labelledBy, aside, asideVisible, headExtra }) {
  const ref = useRef(null);
  const wrapRef = useRef(null);
  const prevFocus = useRef(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const titleId = useRef('dlg-' + Math.random().toString(36).slice(2, 8)).current;
  useEffect(() => {
    prevFocus.current = document.activeElement;
    openCount++;
    document.body.classList.add('no-scroll');
    const el = ref.current;
    // El foco inicial va al diálogo; Esc y Tab se manejan en todo el fondo (incluye la guía de al lado).
    const wrap = wrapRef.current || el;
    const first = el?.querySelector('[data-autofocus]') || el?.querySelector('input,select,textarea,button:not(.dlg-x):not(.guide-toggle):not(.guide-toggle-m)') || el;
    setTimeout(() => first?.focus?.(), 30);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current?.(); }
      if (e.key === 'Tab' && wrap) {
        const f = [...wrap.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')];
        if (!f.length) return;
        const a = f[0], b = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    wrap?.addEventListener('keydown', onKey);
    return () => {
      wrap?.removeEventListener('keydown', onKey);
      openCount--;
      if (!openCount) document.body.classList.remove('no-scroll');
      try { prevFocus.current?.focus?.(); } catch { /* */ }
    };
  }, []);
  return html`<div class=${cx('dlg-wrap', side && 'dlg-side')} ref=${wrapRef} onPointerDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${cx('dlg', wide && 'dlg-wide')} role="dialog" aria-modal=${aside && asideVisible ? undefined : 'true'} aria-labelledby=${labelledBy || titleId} ref=${ref} tabindex="-1">
      <header class="dlg-head">
        <div class="dlg-titles">
          <h2 id=${titleId}>${title}</h2>
          ${subtitle ? html`<p class="muted small">${subtitle}</p>` : null}
        </div>
        ${headExtra || null}
        <button type="button" class="btn btn-ghost btn-icon dlg-x" aria-label="Cerrar" onClick=${onClose}><${Icon} name="x" /></button>
      </header>
      <div class="dlg-body">${children}</div>
      ${footer ? html`<footer class="dlg-foot">${footer}</footer>` : null}
    </div>
    ${aside || null}
  </div>`;
}

// ─── Confirmación ────────────────────────────────────────────────────────────
const confirmState = createStore(null);
/** await confirmDialog({ title, body, confirm: 'Borrar', danger: true }) → true/false */
export function confirmDialog(opts) {
  return new Promise((resolve) => confirmState.set({ ...opts, resolve }));
}

export function ConfirmHost() {
  const c = useStore(confirmState);
  const [busy, setBusy] = useState(false);
  if (!c) return null;
  const close = (v) => { confirmState.set(null); setBusy(false); c.resolve(v); };
  return html`<${Modal} title=${c.title} onClose=${() => close(false)}
    footer=${html`
      <${Button} kind="ghost" onClick=${() => close(false)}>${c.cancel || 'Cancelar'}</${Button}>
      <${Button} kind=${c.danger ? 'danger' : 'primary'} loading=${busy} data-autofocus onClick=${() => close(true)}>${c.confirm || 'Confirmar'}</${Button}>`}>
    ${c.body ? html`<p>${c.body}</p>` : null}
  </${Modal}>`;
}
