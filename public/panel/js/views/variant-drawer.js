// Detalle de variante: números, ajuste con motivo, vínculos con TN, sync con progreso real e historial.
import { html, useMemo, useState } from '../../vendor/htm-preact-3.1.1.js';
import { api, apiStream } from '../lib/api.js';
import { useResource, invalidate, useStore } from '../lib/store.js';
import { fmtNum, fmtDate, stockTone, plural } from '../lib/format.js';
import { normActivityItem } from '../lib/normalize.js';
import { PRODUCTOS_KEY, saveStock, rowState, linkTn, unlinkTn, deleteVariante } from '../lib/stock-actions.js';
import { Button, ErrorBox, SkeletonRows, Empty, Progress, Pill, Refreshing, useAction, cx } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { Modal, toast, confirmDialog } from '../ui/overlay.js';
import { TnPicker } from '../ui/tn-picker.js';
import { ActivityFeed } from '../ui/activity-list.js';
import { GuidePanel, GuideToggle, useGuideColumn } from '../ui/guide.js';

const enc = encodeURIComponent;

function AdjustForm({ p, v }) {
  const [mode, setMode] = useState('add');
  const [n, setN] = useState('');
  const [reason, setReason] = useState('');
  const [run, st] = useAction(async () => {
    const val = Number(n);
    const opts = mode === 'set' ? { absolute: val } : { delta: mode === 'add' ? val : -val };
    if (reason.trim()) opts.reason = reason.trim();
    return saveStock(p.id, v.id, opts, `${p.nombre} · ${v.label}`);
  });
  const valid = n !== '' && !isNaN(Number(n)) && Number(n) >= 0 && (mode === 'set' || Number(n) > 0);
  const submit = async (e) => { e.preventDefault(); if (!valid) return; if (await run()) { setN(''); setReason(''); } };
  const preview = !valid ? null : mode === 'set' ? Number(n) : Math.max(0, v.stock + (mode === 'add' ? 1 : -1) * Number(n));
  return html`<form class="adjust" onSubmit=${submit}>
    <div class="seg" role="radiogroup" aria-label="Tipo de ajuste">
      ${[['add', 'Sumar'], ['sub', 'Restar'], ['set', 'Fijar en']].map(([k, l]) => html`<button type="button" role="radio" aria-checked=${mode === k ? 'true' : 'false'}
        class=${cx('seg-b', mode === k && 'seg-on')} onClick=${() => setMode(k)}>${l}</button>`)}
    </div>
    <div class="adjust-row">
      <input type="number" min="0" step="1" inputmode="numeric" value=${n} onInput=${(e) => setN(e.currentTarget.value)} placeholder=${mode === 'set' ? String(v.stock) : '1'} aria-label="Cantidad" />
      <input type="text" value=${reason} onInput=${(e) => setReason(e.currentTarget.value)} placeholder="Motivo (opcional): ingreso de mercadería, falla…" maxlength="120" aria-label="Motivo" />
      <${Button} type="submit" kind="primary" disabled=${!valid} loading=${st.loading} busyText="Guardando…">Guardar</${Button}>
    </div>
    ${preview != null ? html`<p class="muted small">Stock físico: ${fmtNum(v.stock)} → <strong>${fmtNum(preview)}</strong>. Se actualiza Tiendanube al guardar.</p>` : null}
    <${ErrorBox} compact error=${st.error} onRetry=${() => run()} />
  </form>`;
}

function SyncBlock({ p, v }) {
  const [s, setS] = useState(null);
  const run = async () => {
    setS({ running: true, current: 0, total: v.links.length, results: [], error: null, done: null });
    try {
      const last = await apiStream(`/api/productos/${enc(p.id)}/variantes/${enc(v.id)}/sync`, {
        onEvent: (ev) => {
          if (ev.type === 'progress') setS(x => ({ ...x, current: ev.current, total: ev.total, label: ev.label, results: [...x.results, { label: ev.label, ok: ev.ok }] }));
        },
      });
      if (last.type === 'error') throw new Error(last.error || 'Falló la sincronización');
      const errs = last.errors || [];
      setS(x => ({ ...x, running: false, done: last }));
      if (errs.length) toast(`Sync: ${errs.length} de ${last.total} con error`, { tone: 'warn' });
      else toast(`Tiendanube actualizado (${last.updated}/${last.total})`);
      invalidate(PRODUCTOS_KEY, { delay: 0 }); invalidate('log:' + p.id); invalidate('alerts');
    } catch (e) {
      setS(x => ({ ...x, running: false, error: e }));
    }
  };
  const errs = s?.done?.errors || [];
  return html`<div class="syncblock">
    <div class="row-between">
      <${Button} icon="refresh" onClick=${run} loading=${s?.running} disabled=${!v.links.length} busyText="Sincronizando…">Sincronizar con TN</${Button}>
      ${s?.running ? html`<span class="muted small">${s.total ? `${s.current} de ${s.total}` : 'conectando…'}</span>` : null}
      ${s?.done && !errs.length ? html`<span class="tone-ok small"><${Icon} name="check" size=${14} /> ${s.done.updated}/${s.done.total} actualizados</span>` : null}
    </div>
    ${s?.running || s?.done ? html`<${Progress} current=${s.running ? s.current : (s.done?.total || 1)} total=${s.total || s.done?.total || 0}
      tone=${errs.length ? 'bad' : s.done ? 'ok' : ''} label="Progreso de sincronización" />` : null}
    ${s?.running && s.label ? html`<p class="muted small">Actualizando ${s.label}…</p>` : null}
    ${errs.length ? html`<ul class="sync-errs">${errs.map(e => html`<li key=${e.variant_id}><${Icon} name="alert" size=${14} /><span><strong>${e.label || e.variant_id}</strong>: ${e.error}</span></li>`)}</ul>` : null}
    <${ErrorBox} compact error=${s?.error} onRetry=${run} />
  </div>`;
}

function LinkRow({ p, v, l }) {
  const [confirming, setConfirming] = useState(false);
  const [run, st] = useAction(async () => { await unlinkTn(p.id, v.id, l.variant_id); toast('Desvinculado'); });
  const diff = l.tn_stock != null && Number(l.tn_stock) !== v.disponible;
  return html`<li class="link">
    <div class="link-main">
      <span>${l.label || `Producto ${l.product_id} · variante ${l.variant_id}`}</span>
      <span class="muted small">ID ${l.variant_id}</span>
      ${l.missing_in_tn ? html`<span class="tone-bad small">Ya no existe en Tiendanube: desvinculala.</span>` : null}
      ${l.sync_error ? html`<span class="tone-bad small">Último sync falló: ${l.sync_error}</span>` : null}
    </div>
    <span class=${cx('link-tn', diff && 'tone-warn')} title=${diff ? 'Lo último que se subió a TN no coincide con lo disponible. Sincronizá.' : 'Stock en Tiendanube'}>
      TN: ${l.tn_stock == null ? '—' : fmtNum(l.tn_stock)}${diff ? ' · difiere' : ''}</span>
    ${confirming
      ? html`<span class="confirm-inline"><span class="small">¿Desvincular?</span>
          <${Button} size="sm" kind="danger" loading=${st.loading} onClick=${run}>Sí</${Button}>
          <${Button} size="sm" kind="ghost" onClick=${() => setConfirming(false)}>No</${Button}></span>`
      : html`<${Button} size="sm" kind="ghost" icon="unlink" label="Desvincular" title="Desvincular" onClick=${() => setConfirming(true)} />`}
    ${st.error ? html`<div class="link-err"><${ErrorBox} compact error=${st.error} onRetry=${run} /></div>` : null}
  </li>`;
}

function Links({ p, v, productos }) {
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(null);
  const [err, setErr] = useState(null);
  const usedIds = useMemo(() => new Set(productos.flatMap(pp => pp.variantes.flatMap(vv => vv.links.map(l => String(l.variant_id))))), [productos]);
  const pick = async ({ product, variant }) => {
    setPicking(variant.id); setErr(null);
    try {
      await linkTn(p.id, v.id, { product_id: product.id, variant_id: variant.id, label: `${product.name} · ${variant.label}` });
      toast(`Vinculado: ${product.name} · ${variant.label}. Sincronizá para subirle el stock.`);
      setAdding(false);
    } catch (e) { setErr(e); } finally { setPicking(null); }
  };
  return html`<section class="dsec">
    <div class="sec-head"><h3>En Tiendanube <span class="muted">(${v.links.length})</span></h3></div>
    ${v.sync_error ? html`<p class="warnline tone-bad"><${Icon} name="alert" size=${14} />Último sync: ${v.sync_error}</p>` : null}
    ${v.links.length ? html`<ul class="links">${v.links.map(l => html`<${LinkRow} key=${l.variant_id} p=${p} v=${v} l=${l} />`)}</ul>`
      : html`<p class="muted">No está vinculada a ningún producto de Tiendanube: las ventas no van a descontar de acá.</p>`}
    <${SyncBlock} p=${p} v=${v} />
    ${adding ? html`<div class="addlink">
        <div class="row-between"><strong>Vincular otro producto de Tiendanube</strong><${Button} size="sm" kind="ghost" onClick=${() => setAdding(false)}>Cerrar</${Button}></div>
        <${ErrorBox} compact error=${err} onClose=${() => setErr(null)} />
        <${TnPicker} mode="variant" autoFocus disabledIds=${usedIds} picking=${picking} onPick=${pick} />
      </div>`
      : html`<${Button} kind="ghost" icon="link" onClick=${() => setAdding(true)}>Vincular otro producto de TN</${Button}>`}
  </section>`;
}

function History({ p, v }) {
  const key = `log:${p.id}:${v.id}`;
  const r = useResource(key, async (signal) => {
    try {
      const d = await api(`/api/productos/${enc(p.id)}/variantes/${enc(v.id)}/log?limit=200`, { signal });
      return { items: (Array.isArray(d) ? d : d?.items || []).map(normActivityItem) };
    } catch (e) {
      // Backend viejo: el log venía dentro de /api/productos.
      if (e.status === 404 && v.legacyLog) return { items: v.legacyLog, legacy: true };
      throw e;
    }
  });
  const [showSync, setShowSync] = useState(false);
  const items = (r.data?.items || []).filter(i => showSync || i.action !== 'sync' || i.category === 'error');
  return html`<section class="dsec">
    <div class="sec-head"><h3>Historial</h3><${Refreshing} on=${r.refreshing} />
      <label class="check small"><input type="checkbox" checked=${showSync} onChange=${(e) => setShowSync(e.currentTarget.checked)} /> Mostrar syncs</label></div>
    ${r.loading ? html`<${SkeletonRows} rows=${3} h=${44} />` : null}
    <${ErrorBox} error=${r.error && !r.data ? r.error : null} title="No se pudo cargar el historial" onRetry=${r.reload} />
    ${r.data && !items.length ? html`<${Empty} icon="activity" title="Sin movimientos" />` : null}
    ${items.length ? html`<${ActivityFeed} items=${items} linkable=${false} hideName />` : null}
  </section>`;
}

export function VariantDrawer({ p, v, productos, onClose }) {
  const rs = useStore(rowState, (s) => (v ? s[v.id] : null));
  const guideCol = useGuideColumn();
  if (!p || !v) {
    return html`<${Modal} side title="Variante no encontrada" onClose=${onClose}>
      <${Empty} icon="info" title="Esta variante ya no existe">Puede que la hayan borrado. Cerrá y buscala de nuevo.</${Empty}>
    </${Modal}>`;
  }
  const tone = stockTone(v.disponible);
  const del = async () => {
    const ok = await confirmDialog({ title: `¿Borrar ${v.label}?`, body: `Se borra de ${p.nombre} en Stock Central con sus vínculos. En Tiendanube no se toca nada.`, confirm: 'Borrar variante', danger: true });
    if (!ok) return;
    try { await deleteVariante(p.id, v.id); toast(`${v.label} borrada`); onClose(); }
    catch (e) { toast(`No se pudo borrar: ${e.message}`, { tone: 'bad' }); }
  };
  return html`<${Modal} side title=${v.label} subtitle=${p.nombre} onClose=${onClose}
    headExtra=${html`<${GuideToggle} where="drawer" />`}
    aside=${html`<${GuidePanel} id="variante" where="drawer" />`} asideVisible=${guideCol}>
    <div class="dnums">
      <div class="dnum"><span class="stat-label">Disponible</span><span class=${'stat-value tone-' + tone}>${fmtNum(v.disponible)}</span></div>
      <div class="dnum"><span class="stat-label">Físico</span><span class="stat-value">${fmtNum(v.stock)}</span></div>
      <div class="dnum"><span class="stat-label">En carritos</span><span class=${cx('stat-value', v.reservado > 0 && 'tone-warn')}>${fmtNum(v.reservado)}</span></div>
      ${v.vendidas_7d != null ? html`<div class="dnum"><span class="stat-label">Vendidas 7 d</span><span class="stat-value tone-ok">${fmtNum(v.vendidas_7d)}</span></div>` : null}
    </div>
    <p class="muted small">
      ${v.last_sale_at ? `Última venta ${fmtDate(v.last_sale_at)} · ` : ''}${v.last_movement_at ? `Último movimiento ${fmtDate(v.last_movement_at)}` : ''}
      ${v.matchs ? ` · Usada en ${plural(v.matchs, 'combo', 'combos')}` : ''}
      ${rs?.saving ? html` · <span class="spinner" style="width:12px;height:12px"></span> guardando…` : ''}
    </p>
    ${rs?.error ? html`<${ErrorBox} compact error=${rs.error.message} onRetry=${rs.error.retry} />` : null}
    <section class="dsec"><h3>Ajustar stock</h3><${AdjustForm} p=${p} v=${v} /></section>
    <${Links} p=${p} v=${v} productos=${productos} />
    <${History} p=${p} v=${v} />
    <section class="dsec">
      <${Button} kind="ghost" class="tone-bad" icon="trash" onClick=${del}>Borrar variante</${Button}>
    </section>
  </${Modal}>`;
}
