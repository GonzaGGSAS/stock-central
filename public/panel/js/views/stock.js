// Stock: lista de productos con búsqueda instantánea, filtros y ajuste inline.
import { html, useMemo, useState, useEffect, useRef } from '../../vendor/htm-preact-3.1.1.js';
import { api } from '../lib/api.js';
import { useResource, useStore } from '../lib/store.js';
import { fmtNum, fold, stockTone, plural } from '../lib/format.js';
import { normProductos } from '../lib/normalize.js';
import { setQuery } from '../lib/router.js';
import { PRODUCTOS_KEY, applyOverlay, rowState, bumpStock, saveStock, clearRowError, deleteProducto, addVariante, importVariantesTn, importProducto, createProducto } from '../lib/stock-actions.js';
import { startJob } from '../lib/jobs.js';
import { Button, ErrorBox, SkeletonRows, Skeleton, Empty, Chip, Refreshing, Menu, Pill, Field, useDebounced, useAction, StaleError, cx } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { Modal, toast, confirmDialog } from '../ui/overlay.js';
import { TnPicker } from '../ui/tn-picker.js';
import { VariantDrawer } from './variant-drawer.js';

export const fetchProductos = (signal) => api('/api/productos?lite=1', { signal, timeout: 60000 }).then(normProductos).then(applyOverlay);
export const useProductos = () => useResource(PRODUCTOS_KEY, fetchProductos);

const FILTERS = [
  { id: 'todos', label: 'Todos', test: () => true },
  { id: 'sin', label: 'Sin stock', test: (v) => v.disponible <= 0, tone: 'bad' },
  { id: 'bajo', label: 'Stock bajo', test: (v) => v.disponible >= 1 && v.disponible <= 3, tone: 'warn' },
  { id: 'carrito', label: 'Con carrito', test: (v) => v.reservado > 0, tone: 'warn' },
  { id: 'error', label: 'Con error', test: (v) => !!v.sync_error, tone: 'bad', hideEmpty: true },
  { id: 'novinc', label: 'Sin vincular', test: (v) => !v.links.length, hideEmpty: true },
];
const PAGE = 25;

// ─── Fila de variante ────────────────────────────────────────────────────────
function SetForm({ p, v, onClose }) {
  const [val, setVal] = useState(String(v.stock));
  const [reason, setReason] = useState('');
  const [run, st] = useAction(() => saveStock(p.id, v.id, { absolute: Number(val), reason: reason.trim() }, `${p.nombre} · ${v.label}`));
  const submit = async (e) => {
    e.preventDefault();
    if (val === '' || isNaN(Number(val)) || Number(val) < 0) return;
    const r = await run();
    if (r) onClose();
  };
  return html`<form class="setform" onSubmit=${submit}>
    <label class="setform-n"><span class="sr-only">Stock físico nuevo</span>
      <input type="number" inputmode="numeric" min="0" step="1" value=${val} onInput=${(e) => setVal(e.currentTarget.value)} data-autofocus required aria-label="Stock físico nuevo" /></label>
    <label class="setform-r"><span class="sr-only">Motivo</span>
      <input type="text" value=${reason} onInput=${(e) => setReason(e.currentTarget.value)} placeholder="Motivo (opcional)" maxlength="120" aria-label="Motivo (opcional)" /></label>
    <${Button} type="submit" kind="primary" size="sm" loading=${st.loading}>Guardar</${Button}>
    <${Button} size="sm" kind="ghost" onClick=${onClose}>Cancelar</${Button}>
  </form>`;
}

function VarRow({ p, v, onOpen }) {
  const rs = useStore(rowState, (s) => s[v.id]);
  const [setting, setSetting] = useState(false);
  const formRef = useRef(null);
  useEffect(() => { if (setting) formRef.current?.querySelector('input')?.focus(); }, [setting]);
  const tone = stockTone(v.disponible);
  const label = `${p.nombre} · ${v.label}`;
  return html`<li class=${cx('var', rs?.saving && 'var-saving')}>
    <button type="button" class="var-name" onClick=${() => onOpen(v)} title="Ver detalle, vínculos e historial">
      <span class="var-label">${v.label}</span>
      <span class="var-meta">
        ${v.links.length ? html`<span class="muted small">${plural(v.links.length, 'en TN', 'en TN')}</span>` : html`<${Pill} tone="warn">Sin vincular</${Pill}>`}
        ${v.sync_error ? html`<${Pill} tone="bad" title=${v.sync_error}>Error de sync</${Pill}>` : null}
        ${v.matchs ? html`<span class="muted small">${plural(v.matchs, 'combo', 'combos')}</span>` : null}
      </span>
    </button>
    <div class="var-nums" aria-label=${`Disponible ${v.disponible}, físico ${v.stock}, reservado ${v.reservado}`}>
      <span class=${cx('num-big', 'tone-' + tone)}>${fmtNum(v.disponible)}</span>
      <span class="num-small"><span>físico ${fmtNum(v.stock)}</span>${v.reservado ? html`<span class="tone-warn"> · ${fmtNum(v.reservado)} en carrito</span>` : null}</span>
    </div>
    <div class="var-adj" role="group" aria-label=${'Ajustar stock de ' + label}>
      <button type="button" class="btn btn-icon btn-step" aria-label="Restar 1" disabled=${v.stock <= 0} onClick=${() => bumpStock(p.id, v.id, -1, label)}><${Icon} name="minus" /></button>
      <button type="button" class="btn btn-icon btn-step" aria-label="Sumar 1" onClick=${() => bumpStock(p.id, v.id, +1, label)}><${Icon} name="plus" /></button>
      <button type="button" class="btn btn-sm btn-ghost" aria-expanded=${setting ? 'true' : 'false'} onClick=${() => setSetting(s => !s)}>Fijar</button>
      <span class="var-status" aria-live="polite">${rs?.saving ? html`<span class="spinner" style="width:14px;height:14px" aria-label="Guardando"></span>` : null}</span>
    </div>
    ${setting ? html`<div class="var-extra" ref=${formRef}><${SetForm} p=${p} v=${v} onClose=${() => setSetting(false)} /></div>` : null}
    ${rs?.error ? html`<div class="var-extra"><${ErrorBox} compact error=${rs.error.message} onRetry=${rs.error.retry} onClose=${() => clearRowError(v.id)} /></div>` : null}
    ${rs?.warn && !rs?.error ? html`<div class="var-extra"><p class="warnline"><${Icon} name="alert" size=${14} />${rs.warn}</p></div>` : null}
  </li>`;
}

// ─── Tarjeta de producto ─────────────────────────────────────────────────────
function ProductCard({ p, variantes, onOpen, onAddVar }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);
  const act = async (key, fn) => {
    setBusy(key); setErr(null);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(''); }
  };
  const hidden = p.variantes.length - variantes.length;
  return html`<section class="prod" aria-labelledby=${'p-' + p.id}>
    <header class="prod-head">
      <div class="prod-title">
        <h2 id=${'p-' + p.id}>${p.nombre}</h2>
        <span class="muted small">${fmtNum(p.disponibles)} disponibles · ${plural(p.variantes.length, 'variante', 'variantes')}${p.sin_stock ? html` · <span class="tone-bad">${p.sin_stock} sin stock</span>` : ''}</span>
      </div>
      ${busy ? html`<span class="muted small busyline"><span class="spinner" style="width:14px;height:14px"></span>${busy}</span>` : null}
      <${Menu} label=${'Acciones de ' + p.nombre} items=${[
        { label: 'Agregar variante', icon: 'plus', onClick: () => onAddVar(p) },
        { label: 'Traer variantes nuevas de TN', icon: 'download', onClick: () => act('Trayendo variantes de TN…', async () => {
          const r = await importVariantesTn(p.id);
          toast(r?.added ? `${p.nombre}: ${plural(r.added, 'variante nueva', 'variantes nuevas')}` : `${p.nombre}: no había variantes nuevas`);
        }) },
        { label: 'Sincronizar producto con TN', icon: 'refresh', onClick: () => act('Iniciando sync…', async () => {
          await startJob('sync-product', { productoId: p.id });
          toast(`Sincronizando ${p.nombre}… (lo ves en Ajustes)`, { tone: 'warn' });
        }) },
        { label: 'Borrar producto', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirmDialog({ title: `¿Borrar ${p.nombre}?`, body: 'Se borra de Stock Central con todas sus variantes y vínculos. En Tiendanube no se toca nada.', confirm: 'Borrar', danger: true });
          if (ok) act('Borrando…', async () => { await deleteProducto(p.id); toast(`${p.nombre} borrado`); });
        } },
      ]} />
    </header>
    <${ErrorBox} compact error=${err} onClose=${() => setErr(null)} />
    ${p.variantes.length === 0 ? html`<p class="muted pad">Sin variantes. <button type="button" class="linklike" onClick=${() => onAddVar(p)}>Agregar una</button>.</p>` : null}
    <ul class="vars">${variantes.map(v => html`<${VarRow} key=${v.id} p=${p} v=${v} onOpen=${onOpen} />`)}</ul>
    ${hidden > 0 ? html`<p class="muted small pad">${plural(hidden, 'variante oculta', 'variantes ocultas')} por el filtro.</p>` : null}
  </section>`;
}

// ─── Modales: importar / producto vacío / variante ───────────────────────────
function ImportModal({ productos, onClose }) {
  const [tab, setTab] = useState('tn');
  const [sel, setSel] = useState(null);
  const [nombre, setNombre] = useState('');
  const [id, setId] = useState('');
  const imported = useMemo(() => new Set(productos.flatMap(p => p.variantes.flatMap(v => v.links.map(l => String(l.product_id))))), [productos]);
  const [run, st] = useAction(async () => {
    if (tab === 'tn') {
      const body = { tn_product_id: sel.id };
      if (nombre.trim() && nombre.trim() !== sel.name) body.nombre = nombre.trim();
      if (id.trim()) body.id = id.trim();
      const r = await importProducto(body);
      const sk = Array.isArray(r?.skipped) ? r.skipped.length : 0;
      toast(`Importado: ${r?.nombre || sel.name}${r?.variantes ? ` (${plural(r.variantes.length, 'variante', 'variantes')})` : ''}${sk ? ` · ${sk} ya estaban vinculadas a otro stock` : ''}`, { tone: sk ? 'warn' : 'ok', timeout: sk ? 8000 : 4000 });
      return r;
    }
    const r = await createProducto(id.trim() || nombre.trim(), nombre.trim());
    toast(`Producto creado: ${r?.nombre || nombre}`);
    return r;
  });
  const submit = async (e) => { e?.preventDefault(); const r = await run(); if (r) onClose(r); };
  const canSubmit = tab === 'tn' ? !!sel : !!nombre.trim();
  return html`<${Modal} title="Agregar producto" onClose=${() => onClose()} wide
    footer=${html`<${Button} kind="ghost" onClick=${() => onClose()}>Cancelar</${Button}>
      <${Button} kind="primary" disabled=${!canSubmit} loading=${st.loading} busyText=${tab === 'tn' ? 'Importando…' : 'Creando…'} onClick=${submit}>${tab === 'tn' ? 'Importar' : 'Crear'}</${Button}>`}>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" aria-selected=${tab === 'tn' ? 'true' : 'false'} class=${cx('tab', tab === 'tn' && 'tab-on')} onClick=${() => setTab('tn')}>Desde Tiendanube</button>
      <button type="button" role="tab" aria-selected=${tab === 'vacio' ? 'true' : 'false'} class=${cx('tab', tab === 'vacio' && 'tab-on')} onClick=${() => setTab('vacio')}>Producto vacío</button>
    </div>
    ${tab === 'tn' ? html`
      <p class="muted small">Se crea con una variante por cada variante de Tiendanube, ya vinculadas y con el stock actual de la tienda.</p>
      <${TnPicker} mode="product" autoFocus selectedId=${sel?.id} disabledIds=${imported}
        onPick=${({ product }) => { setSel(product); setNombre(product.name); }} />
      ${sel ? html`<form class="form-grid" onSubmit=${submit}>
        <${Field} label="Nombre en Stock Central"><input type="text" value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} /></${Field}>
        <${Field} label="ID (opcional)" hint="Si lo dejás vacío se arma con el nombre."><input type="text" value=${id} onInput=${(e) => setId(e.currentTarget.value)} placeholder="REMERA_NEGRA" /></${Field}>
      </form>` : null}` : html`
      <form class="form-grid" onSubmit=${submit}>
        <${Field} label="Nombre"><input type="text" value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} data-autofocus required placeholder="Remera negra" /></${Field}>
        <${Field} label="ID (opcional)" hint="Mayúsculas y guiones bajos. Si lo dejás vacío se usa el nombre."><input type="text" value=${id} onInput=${(e) => setId(e.currentTarget.value)} placeholder="REMERA_NEGRA" /></${Field}>
      </form>`}
    <${ErrorBox} error=${st.error} title=${tab === 'tn' ? 'No se pudo importar' : 'No se pudo crear'} onRetry=${submit} />
  </${Modal}>`;
}

function AddVarModal({ p, onClose }) {
  const [label, setLabel] = useState('');
  const [stock, setStock] = useState('0');
  const [run, st] = useAction(async () => { const r = await addVariante(p.id, label.trim(), stock); toast(`Variante ${label} agregada`); return r; });
  const submit = async (e) => { e?.preventDefault(); if (!label.trim()) return; if (await run()) onClose(); };
  return html`<${Modal} title="Agregar variante" subtitle=${p.nombre} onClose=${onClose}
    footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancelar</${Button}><${Button} kind="primary" disabled=${!label.trim()} loading=${st.loading} onClick=${submit}>Agregar</${Button}>`}>
    <form class="form-grid" onSubmit=${submit}>
      <${Field} label="Talle / variante"><input type="text" value=${label} onInput=${(e) => setLabel(e.currentTarget.value)} data-autofocus required placeholder="M" /></${Field}>
      <${Field} label="Stock inicial"><input type="number" min="0" inputmode="numeric" value=${stock} onInput=${(e) => setStock(e.currentTarget.value)} /></${Field}>
    </form>
    <p class="muted small">Después vinculala a sus productos de Tiendanube desde el detalle.</p>
    <${ErrorBox} error=${st.error} onRetry=${submit} />
  </${Modal}>`;
}

// ─── Vista ───────────────────────────────────────────────────────────────────
export function Stock({ query }) {
  const r = useProductos();
  const [q, setQ] = useState(query.q || '');
  const dq = useDebounced(q, 120);
  const f = FILTERS.find(x => x.id === query.f) || FILTERS[0];
  const [limit, setLimit] = useState(PAGE);
  const [modal, setModal] = useState(null);
  const list = r.data || [];

  useEffect(() => { setLimit(PAGE); }, [dq, f.id]);
  useEffect(() => { if ((query.q || '') !== dq) setQuery({ q: dq || '' }); }, [dq]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(FILTERS.map(x => [x.id, 0]));
    for (const p of list) for (const v of p.variantes) for (const x of FILTERS) if (x.test(v)) c[x.id]++;
    return c;
  }, [list]);

  const filtered = useMemo(() => {
    const terms = fold(dq).split(/\s+/).filter(Boolean);
    const out = [];
    for (const p of list) {
      const pText = fold(p.nombre + ' ' + p.id);
      const pMatch = terms.every(t => pText.includes(t));
      const vs = p.variantes.filter(v => {
        if (!f.test(v)) return false;
        if (!terms.length || pMatch) return true;
        const vText = pText + ' ' + fold(v.label + ' ' + v.links.map(l => l.label + ' ' + l.variant_id).join(' '));
        return terms.every(t => vText.includes(t));
      });
      if (vs.length || (f.id === 'todos' && pMatch && !p.variantes.length)) out.push({ p, vs });
    }
    return out;
  }, [list, dq, f]);

  const sel = (query.v || '').split('|');
  const selP = sel.length === 2 ? list.find(p => p.id === sel[0]) : null;
  const selV = selP?.variantes.find(v => v.id === sel[1]);
  const openVar = (p) => (v) => setQuery({ v: `${p.id}|${v.id}` }, { push: true });

  return html`<div class="view view-stock">
    <div class="view-head">
      <h1>Stock</h1>
      <${Refreshing} on=${r.refreshing} />
      <div class="grow"></div>
      <${Button} kind="primary" icon="plus" onClick=${() => setModal({ type: 'import' })}>Agregar producto</${Button}>
    </div>
    <div class="toolbar">
      <div class="search search-lg">
        <${Icon} name="search" size=${18} />
        <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Buscar producto, talle o ID de TN…" aria-label="Buscar en stock" />
        ${q ? html`<button type="button" class="search-x" aria-label="Borrar búsqueda" onClick=${() => setQ('')}><${Icon} name="x" size=${16} /></button>` : null}
      </div>
      <div class="chips" role="group" aria-label="Filtrar variantes">
        ${FILTERS.filter(x => !x.hideEmpty || counts[x.id] > 0 || f.id === x.id).map(x => html`<${Chip} key=${x.id} active=${f.id === x.id}
          tone=${x.tone && counts[x.id] > 0 ? x.tone : ''} count=${r.data ? counts[x.id] : null}
          onClick=${() => setQuery({ f: x.id === 'todos' ? '' : x.id })}>${x.label}</${Chip}>`)}
      </div>
    </div>

    ${r.loading ? html`<div class="prod" aria-busy="true"><${Skeleton} h=${20} w="35%" /><div class="gap"></div><${SkeletonRows} rows=${5} h=${52} /></div>` : null}
    ${r.error && !r.data ? html`<${ErrorBox} title="No se pudo cargar el stock" error=${r.error} onRetry=${r.reload} />` : null}
    <${StaleError} r=${r} />
    ${r.data && !list.length ? html`<${Empty} icon="box" title="Todavía no hay productos">Importá uno desde Tiendanube con “Agregar producto”.</${Empty}>` : null}
    ${r.data && list.length && !filtered.length ? html`<${Empty} icon="search" title="Nada coincide">Probá con otra búsqueda o sacá el filtro.</${Empty}>` : null}

    ${filtered.slice(0, limit).map(({ p, vs }) => html`<${ProductCard} key=${p.id} p=${p} variantes=${vs} onOpen=${openVar(p)} onAddVar=${(pp) => setModal({ type: 'addvar', p: pp })} />`)}
    ${filtered.length > limit ? html`<div class="more"><${Button} onClick=${() => setLimit(l => l + PAGE)}>Mostrar ${Math.min(PAGE, filtered.length - limit)} más (de ${filtered.length - limit})</${Button}></div>` : null}

    ${modal?.type === 'import' ? html`<${ImportModal} productos=${list} onClose=${(created) => { setModal(null); if (created?.id) setQ(created.nombre || created.id); }} />` : null}
    ${modal?.type === 'addvar' ? html`<${AddVarModal} p=${modal.p} onClose=${() => setModal(null)} />` : null}
    ${query.v && r.data ? html`<${VariantDrawer} p=${selP} v=${selV} productos=${list} onClose=${() => setQuery({ v: '' })} />` : null}
  </div>`;
}
