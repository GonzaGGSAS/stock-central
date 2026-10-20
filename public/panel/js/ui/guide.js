// Guía de ayuda de cada pantalla.
// · Escritorio (≥768px): columna al costado derecho, colapsable. El estado se recuerda en este navegador.
// · Celular (<768px): botón flotante "?" que abre la guía como hoja desde abajo.
// En el detalle de un talle (drawer) la guía va pegada al costado del drawer, y en el celular se abre
// desde el botón "?" del encabezado del drawer (así el botón flotante no tapa nada).
import { html, useEffect, useRef, useState } from '../../vendor/htm-preact-3.1.1.js';
import { createStore, useStore } from '../lib/store.js';
import { Icon } from './icons.js';
import { cx } from './components.js';
import { Art } from './guide-art.js';
import { GUIDES } from './guide-content.js';

const LS_KEY = 'sc_guide_open';
const MOBILE_Q = '(max-width: 767px)';

function initialOpen() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* sin storage: valor por defecto */ }
  // Sin preferencia guardada: abierta si la pantalla es ancha (si no, aprieta mucho el contenido).
  try { return window.innerWidth >= 1100; } catch { return true; }
}

/** open: columna visible en escritorio · sheet: 'page' | 'drawer' | null (hoja abierta en el celular) */
export const guideUi = createStore({ open: initialOpen(), sheet: null });

export function setGuideOpen(open) {
  guideUi.set(s => ({ ...s, open }));
  try { localStorage.setItem(LS_KEY, open ? '1' : '0'); } catch { /* */ }
}
const openSheet = (where) => guideUi.set(s => ({ ...s, sheet: where }));
const closeSheet = () => guideUi.set(s => ({ ...s, sheet: null }));

const mql = typeof matchMedia === 'function' ? matchMedia(MOBILE_Q) : null;
export function useMobile() {
  const [m, setM] = useState(() => !!mql?.matches);
  useEffect(() => {
    if (!mql) return;
    const on = () => setM(mql.matches);
    on();
    mql.addEventListener ? mql.addEventListener('change', on) : mql.addListener(on);
    return () => { mql.removeEventListener ? mql.removeEventListener('change', on) : mql.removeListener(on); };
  }, []);
  return m;
}
// Al pasar a escritorio, una hoja abierta no tiene sentido.
mql?.addEventListener?.('change', (e) => { if (!e.matches) closeSheet(); });

/** ¿La columna de la guía ocupa lugar en la página? (el shell lo usa para armar la grilla) */
export function useGuideColumn() {
  const mobile = useMobile();
  const open = useStore(guideUi, s => s.open);
  return !mobile && open;
}

/** Qué guía corresponde a la ruta actual. */
export const guideIdFor = (view) => (GUIDES[view] ? view : 'inicio');

// ─── Texto con **negrita** ───────────────────────────────────────────────────
function Rich({ t }) {
  const parts = String(t).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((p, i) => p.startsWith('**') && p.endsWith('**') ? html`<strong key=${i}>${p.slice(2, -2)}</strong>` : p);
}

function Sample({ it }) {
  const tone = it.tone || 'n';
  if (it.kind === 'pill') return html`<span class=${cx('pill', tone !== 'n' && 'tone-' + tone)}>${it.show}</span>`;
  if (it.kind === 'num') return html`<span class=${cx('guide-num', tone !== 'n' && 'tone-' + tone)} aria-hidden="true">${it.show}</span>`;
  if (it.kind === 'text') return html`<span class=${cx('guide-sample-t', tone !== 'n' && 'tone-' + tone)}>${it.show}</span>`;
  return html`<span class=${'dot dot-' + tone} aria-hidden="true"></span>`;
}

/** Cuerpo de la guía (igual en la columna y en la hoja del celular). */
export function GuideBody({ g, uid }) {
  return html`<div class="guide-body">
    <figure class="guide-hero"><${Art} name=${g.art} label=${g.artLabel} /></figure>

    <section class="guide-sec" aria-labelledby=${uid + '-para'}>
      <h3 id=${uid + '-para'}>¿Para qué sirve?</h3>
      ${g.para.map((p, i) => html`<p key=${i}><${Rich} t=${p} /></p>`)}
    </section>

    <section class="guide-sec" aria-labelledby=${uid + '-uso'}>
      <h3 id=${uid + '-uso'}>Cómo se usa</h3>
      <ol class="guide-steps">${g.pasos.map((p, i) => html`<li key=${i}><span class="guide-step-n" aria-hidden="true">${i + 1}</span><span><${Rich} t=${p} /></span></li>`)}</ol>
    </section>

    ${g.ideas?.length ? html`<section class="guide-sec" aria-labelledby=${uid + '-ideas'}>
      <h3 id=${uid + '-ideas'}>Para entender</h3>
      <ul class="guide-ideas">${g.ideas.map((it, i) => html`<li key=${i} class="guide-idea">
        <${Art} name=${it.art} label=${it.term} small />
        <div><strong>${it.term}</strong><p><${Rich} t=${it.text} /></p></div>
      </li>`)}</ul>
    </section>` : null}

    <section class="guide-sec guide-yes" aria-labelledby=${uid + '-si'}>
      <h3 id=${uid + '-si'}><span class="guide-mark" aria-hidden="true">✔</span> SÍ <span class="guide-h-sub">conviene hacer</span></h3>
      <ul>${g.si.map((p, i) => html`<li key=${i}><${Rich} t=${p} /></li>`)}</ul>
    </section>

    <section class="guide-sec guide-no" aria-labelledby=${uid + '-no'}>
      <h3 id=${uid + '-no'}><span class="guide-mark" aria-hidden="true">✘</span> NO <span class="guide-h-sub">errores comunes</span></h3>
      <ul>${g.no.map((p, i) => html`<li key=${i}><${Rich} t=${p} /></li>`)}</ul>
    </section>

    ${(g.listas || []).map((l, li) => html`<section key=${'l' + li} class="guide-sec" aria-labelledby=${uid + '-l' + li}>
      <h3 id=${uid + '-l' + li}>${l.title}</h3>
      <ul class="guide-legend">${l.items.map((it, i) => html`<li key=${i} class=${'guide-leg-' + (it.kind || 'dot')}>
        <span class="guide-sample"><${Sample} it=${it} /></span><span><${Rich} t=${it.text} /></span>
      </li>`)}</ul>
    </section>`)}
  </div>`;
}

// ─── Botones ─────────────────────────────────────────────────────────────────
/** Botón "Guía" / "Ocultar guía" (escritorio). En el drawer, en el celular abre la hoja. */
export function GuideToggle({ where = 'page' }) {
  const mobile = useMobile();
  const open = useStore(guideUi, s => s.open);
  if (mobile) {
    if (where !== 'drawer') return null; // en las páginas, en el celular está el botón flotante
    return html`<button type="button" class="btn btn-ghost btn-icon guide-toggle-m" aria-label="Ver la guía de esta pantalla"
      title="Guía" aria-haspopup="dialog" onClick=${() => openSheet('drawer')}><${Icon} name="help" /></button>`;
  }
  return html`<button type="button" class=${cx('btn btn-sm guide-toggle', open && 'guide-toggle-on', where === 'drawer' && 'btn-ghost')}
    aria-expanded=${open ? 'true' : 'false'} aria-controls=${'guia-' + where}
    title=${open ? 'Ocultar la guía de ayuda' : 'Mostrar la guía de ayuda'} onClick=${() => setGuideOpen(!open)}>
    <${Icon} name="help" size=${16} /><span>${open ? 'Ocultar guía' : 'Guía'}</span>
  </button>`;
}

// ─── Hoja del celular ────────────────────────────────────────────────────────
function GuideSheet({ g, id, where }) {
  const ref = useRef(null);
  const uid = 'gs-' + where + '-' + id;
  useEffect(() => {
    const prev = document.activeElement;
    const body = document.body;
    const lock = !body.classList.contains('no-scroll');
    if (lock) body.classList.add('no-scroll');
    setTimeout(() => ref.current?.querySelector('.guide-close')?.focus(), 30);
    return () => {
      if (lock) body.classList.remove('no-scroll');
      // Volver al botón que la abrió (Safari no enfoca botones al tocarlos: lo buscamos).
      const opener = document.querySelector(where === 'drawer' ? '.dlg .guide-toggle-m' : '.guide-fab') || prev;
      try { opener?.focus?.(); } catch { /* */ }
    };
  }, []);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheet(); return; }
    if (e.key === 'Tab') {
      e.stopPropagation(); // que el drawer de atrás no se robe el foco
      const f = [...ref.current.querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')];
      if (!f.length) return;
      const a = f[0], b = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    }
  };
  return html`<div class="guide-sheet-wrap" onPointerDown=${(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); closeSheet(); } }}>
    <div class="guide-sheet" role="dialog" aria-modal="true" aria-labelledby=${uid + '-t'} ref=${ref} onKeyDown=${onKey} tabindex="-1">
      <header class="guide-head">
        <div class="guide-titles"><span class="guide-kicker">Guía</span><h2 id=${uid + '-t'}>${g.title}</h2></div>
        <button type="button" class="btn btn-ghost btn-icon guide-close" aria-label="Cerrar la guía" onClick=${closeSheet}><${Icon} name="x" /></button>
      </header>
      <${GuideBody} g=${g} uid=${uid} />
      <div class="guide-sheet-foot"><button type="button" class="btn" onClick=${closeSheet}>Entendido</button></div>
    </div>
  </div>`;
}

// ─── Panel ───────────────────────────────────────────────────────────────────
/**
 * <GuidePanel id="stock" />                 → en la página (columna / botón flotante)
 * <GuidePanel id="variante" where="drawer" /> → al costado del drawer (columna / hoja desde su "?")
 */
export function GuidePanel({ id, where = 'page' }) {
  const mobile = useMobile();
  const ui = useStore(guideUi);
  const g = GUIDES[id];
  if (!g) return null;
  if (mobile) {
    return html`
      ${where === 'page' ? html`<button type="button" class="guide-fab" aria-label=${'Ver la guía de ' + g.title} title="Guía"
        aria-haspopup="dialog" onClick=${() => openSheet('page')}><span aria-hidden="true">?</span></button>` : null}
      ${ui.sheet === where ? html`<${GuideSheet} g=${g} id=${id} where=${where} />` : null}`;
  }
  if (!ui.open) return null;
  const uid = 'g-' + where + '-' + id;
  return html`<aside class=${cx('guide', 'guide-' + where)} id=${'guia-' + where} aria-labelledby=${uid + '-t'}>
    <header class="guide-head">
      <div class="guide-titles"><span class="guide-kicker">Guía</span><h2 id=${uid + '-t'}>${g.title}</h2></div>
      <button type="button" class="btn btn-ghost btn-sm guide-close" aria-controls=${'guia-' + where} aria-expanded="true"
        onClick=${() => {
          setGuideOpen(false);
          // El botón desaparece: el foco pasa al botón "Guía" para poder volver a abrirla.
          setTimeout(() => document.querySelector(where === 'drawer' ? '.dlg .guide-toggle' : '.top .guide-toggle')?.focus(), 0);
        }}><${Icon} name="x" size=${14} /><span>Ocultar guía</span></button>
    </header>
    <${GuideBody} g=${g} uid=${uid} />
  </aside>`;
}
