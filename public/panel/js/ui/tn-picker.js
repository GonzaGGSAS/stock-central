// Buscador sobre los productos de Tiendanube (GET /api/tn-products, lento → cacheado 10 min).
import { html, useMemo, useState } from '../../vendor/htm-preact-3.1.1.js';
import { api } from '../lib/api.js';
import { useResource, invalidate } from '../lib/store.js';
import { fold, fmtNum, fmtDate } from '../lib/format.js';
import { tnText, tnVariantLabel } from '../lib/normalize.js';
import { Button, ErrorBox, Spinner, useElapsed, useDebounced, cx, Pill } from './components.js';
import { Icon } from './icons.js';

const SS_KEY = 'sc_tn_products_v1';
const TTL = 10 * 60 * 1000;
let forceNext = false;

async function fetchTnProducts(signal) {
  if (!forceNext) {
    try {
      const c = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null');
      if (c && Date.now() - c.ts < TTL && Array.isArray(c.data)) return { list: c.data, ts: c.ts };
    } catch { /* sin cache */ }
  }
  forceNext = false;
  const raw = await api('/api/tn-products', { signal, timeout: 180000 });
  const list = (Array.isArray(raw) ? raw : []).map(p => ({
    id: String(p.id),
    name: tnText(p.name) || `Producto ${p.id}`,
    variants: (p.variants || []).map(v => ({ id: String(v.id), label: tnVariantLabel(v), stock: v.stock ?? null, sku: v.sku || '' })),
  }));
  const ts = Date.now();
  try { sessionStorage.setItem(SS_KEY, JSON.stringify({ ts, data: list })); } catch { /* lleno */ }
  return { list, ts };
}

export function useTnProducts() {
  return useResource('tn-products', fetchTnProducts);
}
export function refreshTnProducts() {
  forceNext = true;
  try { sessionStorage.removeItem(SS_KEY); } catch { /* */ }
  invalidate('tn-products', { delay: 0 });
}

function LoadingTn() {
  const s = useElapsed(true);
  return html`<div class="loading-block" role="status">
    <${Spinner} size=${20} />
    <div><strong>Trayendo productos de Tiendanube…</strong>
      <div class="muted small">${s < 4 ? 'Puede tardar unos segundos.' : `Van ${s} s — Tiendanube responde de a 50 productos.`}</div></div>
  </div>`;
}

/**
 * mode="variant": elegir una variante (onPick({product, variant}))
 * mode="product": elegir un producto (onPick({product}))
 * disabledIds: Set de variant_id (o product id en mode product) que ya están usados.
 */
export function TnPicker({ mode = 'variant', onPick, disabledIds, picking, selectedId, autoFocus }) {
  const r = useTnProducts();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 120);
  const list = r.data?.list || [];
  const results = useMemo(() => {
    const terms = fold(dq).split(/\s+/).filter(Boolean);
    const match = (s) => terms.every(t => s.includes(t));
    const out = [];
    for (const p of list) {
      const pn = fold(p.name + ' ' + p.id);
      if (mode === 'product') { if (!terms.length || match(pn)) out.push({ p }); }
      else {
        const vs = p.variants.filter(v => !terms.length || match(pn + ' ' + fold(v.label + ' ' + v.sku + ' ' + v.id)));
        if (vs.length) out.push({ p, vs });
      }
      if (out.length >= 40) break;
    }
    return out;
  }, [list, dq, mode]);

  return html`<div class="picker">
    <div class="search">
      <${Icon} name="search" size=${16} />
      <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} data-autofocus=${autoFocus ? '' : undefined}
        placeholder=${mode === 'product' ? 'Buscá el producto de Tiendanube…' : 'Buscá producto, talle o SKU…'} aria-label="Buscar en Tiendanube" />
    </div>
    <div class="picker-meta muted small">
      ${r.data ? html`<span>${fmtNum(list.length)} productos · lista de ${fmtDate(r.data.ts)}</span>` : null}
      <${Button} size="sm" kind="ghost" icon="refresh" loading=${r.refreshing} onClick=${refreshTnProducts} disabled=${r.loading}>Actualizar lista</${Button}>
    </div>
    ${r.loading ? html`<${LoadingTn} />` : null}
    <${ErrorBox} error=${r.error} title="No se pudo traer la lista de Tiendanube" onRetry=${refreshTnProducts} />
    ${r.data && !results.length ? html`<p class="muted pad">No hay resultados para “${dq}”.</p>` : null}
    <ul class="picker-list">
      ${results.map(({ p, vs }) => mode === 'product'
        ? html`<li key=${p.id}>
            <button type="button" class=${cx('pick', selectedId === p.id && 'pick-on')} disabled=${disabledIds?.has(p.id) || picking}
              onClick=${() => onPick({ product: p })} aria-pressed=${selectedId === p.id ? 'true' : 'false'}>
              <span class="pick-main"><strong>${p.name}</strong><span class="muted small">${p.variants.length} variantes · ID ${p.id}</span></span>
              ${picking === p.id ? html`<${Spinner} />` : selectedId === p.id ? html`<${Icon} name="check" />` : null}
            </button></li>`
        : html`<li key=${p.id} class="pick-group">
            <div class="pick-group-name">${p.name}</div>
            ${vs.map(v => {
              const used = disabledIds?.has(v.id);
              return html`<button key=${v.id} type="button" class="pick" disabled=${used || !!picking} onClick=${() => onPick({ product: p, variant: v })}>
                <span class="pick-main"><span>${v.label}</span>${v.sku ? html`<span class="muted small">SKU ${v.sku}</span>` : null}</span>
                ${used ? html`<${Pill}>Ya vinculada</${Pill}>` : html`<span class="muted small">TN: ${v.stock == null ? '∞' : fmtNum(v.stock)}</span>`}
                ${picking === v.id ? html`<${Spinner} />` : !used ? html`<${Icon} name="link" size=${16} />` : null}
              </button>`;
            })}
          </li>`)}
    </ul>
    ${results.length >= 40 ? html`<p class="muted small pad">Mostrando los primeros 40. Escribí más para afinar.</p>` : null}
  </div>`;
}
