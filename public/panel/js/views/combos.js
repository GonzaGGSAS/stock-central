// Combos (matchs): dos productos de TN en un producto contenedor con todas las combinaciones de talles.
import { html, useState, useMemo } from '../../vendor/htm-preact-3.1.1.js';
import { api } from '../lib/api.js';
import { useResource, mutateResource, invalidate } from '../lib/store.js';
import { fmtNum, fmtMoney, fold, plural, stockTone } from '../lib/format.js';
import { normMatchs, normMatch } from '../lib/normalize.js';
import { startJob, jobsStore, runningJobs } from '../lib/jobs.js';
import { useStore } from '../lib/store.js';
import { Button, ErrorBox, SkeletonRows, Empty, Refreshing, Field, Progress, useAction, useDebounced, Menu, cx, useElapsed, StaleError } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { Modal, toast, confirmDialog } from '../ui/overlay.js';
import { TnPicker } from '../ui/tn-picker.js';

const enc = encodeURIComponent;
const KEY = 'matchs';
export const useMatchs = () => useResource(KEY, (signal) => api('/api/matchs?lite=1', { signal, timeout: 60000 }).then(normMatchs));

function ComboGrid({ m }) {
  if (!m.combos.length) return html`<p class="muted small">Este combo no tiene combinaciones guardadas.</p>`;
  return html`<ul class="combo-grid">
    ${m.combos.map((c, i) => html`<li key=${c.tn_variant_id || i} class=${cx('combo-cell', c.sync_error ? 'tone-bad' : c.stock === null ? 'tone-ok' : c.stock !== undefined && 'tone-' + stockTone(c.stock))} title=${c.sync_error ? 'Error de sync: ' + c.sync_error : undefined}>
      <span class="combo-label">${c.label}</span>
      <span class="combo-stock">${c.stock === undefined ? '—' : c.stock === null ? '∞' : fmtNum(c.stock)}</span>
    </li>`)}
  </ul>`;
}

function MatchCard({ m, onEdit }) {
  const [open, setOpen] = useState(false);
  const [sync, syncSt] = useAction(async () => {
    const r = await api(`/api/matchs/${enc(m.id)}/sync-stock`, { method: 'PUT', timeout: 120000 });
    toast(`${m.nombre}: ${plural(r?.updated ?? 0, 'combinación actualizada', 'combinaciones actualizadas')}`);
    invalidate(KEY, { delay: 0 });
    return r;
  });
  const [del, delSt] = useAction(async () => {
    await api(`/api/matchs/${enc(m.id)}`, { method: 'DELETE', timeout: 60000 });
    mutateResource(KEY, l => l?.filter(x => x.id !== m.id));
    toast(`Combo ${m.nombre} borrado`);
  });
  const askDel = async () => {
    const ok = await confirmDialog({ title: `¿Borrar ${m.nombre}?`, body: 'Se borra el combo y también su producto en Tiendanube. Los productos individuales no se tocan.', confirm: 'Borrar combo', danger: true });
    if (ok) del();
  };
  const total = m.combos_total, con = m.combos_con_stock;
  const pct = total && con != null ? Math.round((con / total) * 100) : null;
  const tone = con == null ? '' : con === 0 ? 'bad' : con / total < 0.5 ? 'warn' : 'ok';
  return html`<article class="match">
    <header class="match-head">
      <div class="match-title">
        <h2>${m.nombre}</h2>
        <span class="muted small">${m.producto1.nombre} + ${m.producto2.nombre}</span>
      </div>
      <div class="match-price">${m.precio_promocional ? html`<s class="muted small">${fmtMoney(m.precio)}</s> ${fmtMoney(m.precio_promocional)}` : fmtMoney(m.precio)}</div>
      <${Menu} label=${'Acciones de ' + m.nombre} items=${[
        { label: 'Editar', icon: 'edit', onClick: () => onEdit(m) },
        { label: 'Sincronizar stock', icon: 'refresh', onClick: () => sync() },
        { label: 'Borrar', icon: 'trash', danger: true, onClick: askDel },
      ]} />
    </header>
    <div class="match-stat">
      <span class=${cx('num-big', tone && 'tone-' + tone)}>${con == null ? '—' : fmtNum(con)}</span>
      <span class="muted">de ${fmtNum(total)} combinaciones con stock${con == null ? ' (sin datos: sincronizá)' : ''}</span>
    </div>
    ${pct != null ? html`<${Progress} small current=${con} total=${total} tone=${tone} label=${`${con} de ${total} combinaciones con stock`} />` : null}
    <div class="match-actions">
      <${Button} size="sm" kind="ghost" icon=${open ? 'down' : 'chevron'} aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(o => !o)}>${open ? 'Ocultar' : 'Ver'} combinaciones</${Button}>
      <${Button} size="sm" icon="refresh" loading=${syncSt.loading} busyText="Sincronizando…" onClick=${() => sync()}>Sincronizar</${Button}>
      ${delSt.loading ? html`<span class="muted small"><span class="spinner" style="width:12px;height:12px"></span> Borrando…</span>` : null}
    </div>
    <${ErrorBox} compact error=${syncSt.error} onRetry=${() => sync()} onClose=${syncSt.reset} />
    <${ErrorBox} compact error=${delSt.error} title="No se pudo borrar" onRetry=${() => del()} onClose=${delSt.reset} />
    ${open ? html`<${ComboGrid} m=${m} />` : null}
  </article>`;
}

function CreatingNote({ on }) {
  const s = useElapsed(on);
  if (!on) return null;
  return html`<p class="muted small" role="status"><span class="spinner" style="width:12px;height:12px"></span> Creando el producto combo en Tiendanube… ${s > 3 ? `(${s} s)` : ''}</p>`;
}

function MatchForm({ m, onClose }) {
  const editing = !!m;
  const [p1, setP1] = useState(null);
  const [p2, setP2] = useState(null);
  const [step, setStep] = useState(editing ? 3 : 1);
  const [nombre, setNombre] = useState(m?.nombre || '');
  const [precio, setPrecio] = useState(m?.precio || '');
  const [promo, setPromo] = useState(m?.precio_promocional || '');
  const [img, setImg] = useState(m?.imagen_url || '');
  const [run, st] = useAction(async () => {
    const extra = {};
    if (precio !== '' && precio != null) extra.precio = String(precio);
    if (promo !== '' && promo != null) extra.precio_promocional = String(promo);
    if (img.trim()) extra.imagen_url = img.trim();
    if (editing) {
      const r = await api(`/api/matchs/${enc(m.id)}`, { method: 'PUT', body: { nombre: nombre.trim(), ...extra }, timeout: 60000 });
      mutateResource(KEY, l => l?.map(x => x.id === m.id ? { ...x, ...normMatch({ ...x, ...r, combos: r?.combos || x.combos, combos_total: r?.combos_total ?? x.combos_total, combos_con_stock: r?.combos_con_stock ?? x.combos_con_stock }) } : x));
      invalidate(KEY);
      toast('Combo actualizado');
      return r;
    }
    const r = await api('/api/matchs', { method: 'POST', timeout: 180000, body: {
      nombre: nombre.trim(),
      producto1: { tn_product_id: p1.id, nombre: p1.name },
      producto2: { tn_product_id: p2.id, nombre: p2.name },
      ...extra,
    } });
    invalidate(KEY, { delay: 0 });
    toast(`Combo creado: ${nombre} (${plural(p1.variants.length * p2.variants.length, 'combinación', 'combinaciones')})`);
    return r;
  });
  const submit = async (e) => { e?.preventDefault(); if (!nombre.trim()) return; if (await run()) onClose(); };
  const pickP = (n) => ({ product }) => {
    if (n === 1) { setP1(product); setStep(2); }
    else { setP2(product); setStep(3); if (!nombre) setNombre(`${p1.name} + ${product.name}`); }
  };
  const footer = html`
    ${step > 1 && !editing ? html`<${Button} kind="ghost" disabled=${st.loading} onClick=${() => setStep(s => s - 1)}>Atrás</${Button}>` : html`<${Button} kind="ghost" onClick=${onClose}>Cancelar</${Button}>`}
    ${step === 3 ? html`<${Button} kind="primary" loading=${st.loading} busyText=${editing ? 'Guardando…' : 'Creando…'} disabled=${!nombre.trim()} onClick=${submit}>${editing ? 'Guardar' : 'Crear combo'}</${Button}>` : null}`;
  return html`<${Modal} wide title=${editing ? 'Editar combo' : 'Nuevo combo'} subtitle=${editing ? m.nombre : `Paso ${step} de 3`} onClose=${onClose} footer=${footer}>
    ${!editing ? html`<ol class="steps">
      <li class=${cx(step === 1 && 'on', p1 && 'done')}>Producto 1${p1 ? html`: <strong>${p1.name}</strong>` : ''}</li>
      <li class=${cx(step === 2 && 'on', p2 && 'done')}>Producto 2${p2 ? html`: <strong>${p2.name}</strong>` : ''}</li>
      <li class=${cx(step === 3 && 'on')}>Nombre y precio</li>
    </ol>` : null}
    ${step === 1 ? html`<${TnPicker} key="p1" mode="product" autoFocus selectedId=${p1?.id} onPick=${pickP(1)} />` : null}
    ${step === 2 ? html`<${TnPicker} key="p2" mode="product" autoFocus selectedId=${p2?.id} disabledIds=${new Set([p1?.id])} onPick=${pickP(2)} />` : null}
    ${step === 3 ? html`<form class="form-grid" onSubmit=${submit}>
      <${Field} label="Nombre del combo"><input type="text" value=${nombre} onInput=${(e) => setNombre(e.currentTarget.value)} data-autofocus required /></${Field}>
      <div class="form-2">
        <${Field} label="Precio"><input type="number" min="0" inputmode="decimal" value=${precio} onInput=${(e) => setPrecio(e.currentTarget.value)} placeholder="50000" /></${Field}>
        <${Field} label="Precio promocional (opcional)"><input type="number" min="0" inputmode="decimal" value=${promo} onInput=${(e) => setPromo(e.currentTarget.value)} /></${Field}>
      </div>
      <${Field} label="Imagen (URL, opcional)"><input type="url" value=${img} onInput=${(e) => setImg(e.currentTarget.value)} placeholder="https://…" /></${Field}>
      ${!editing && p1 && p2 ? html`<p class="muted small">Se crea en Tiendanube un producto con ${plural(p1.variants.length * p2.variants.length, 'combinación', 'combinaciones')} (${p1.variants.length} × ${p2.variants.length}). El stock de cada una es el menor de los dos.</p>` : null}
    </form>` : null}
    <${CreatingNote} on=${st.loading && !editing} />
    <${ErrorBox} error=${st.error} title=${editing ? 'No se pudo guardar' : 'No se pudo crear el combo'} onRetry=${submit} />
  </${Modal}>`;
}

export function Combos() {
  const r = useMatchs();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 120);
  const [form, setForm] = useState(null);
  const [jobRun, jobSt] = useAction(() => startJob('resync-matchs'));
  const jobs = useStore(jobsStore, runningJobs);
  const job = jobs.find(j => j.type === 'resync-matchs' || j.type === 'repair-matchs');
  const list = r.data || [];
  const filtered = useMemo(() => {
    const t = fold(dq);
    return t ? list.filter(m => fold(`${m.nombre} ${m.producto1.nombre} ${m.producto2.nombre}`).includes(t)) : list;
  }, [list, dq]);
  const totals = useMemo(() => ({
    total: list.reduce((a, m) => a + (m.combos_total || 0), 0),
    con: list.some(m => m.combos_con_stock == null) ? null : list.reduce((a, m) => a + (m.combos_con_stock || 0), 0),
  }), [list]);

  return html`<div class="view view-combos">
    <div class="view-head">
      <h1>Combos</h1>
      <${Refreshing} on=${r.refreshing} />
      <div class="grow"></div>
      <${Button} kind="primary" icon="plus" onClick=${() => setForm({})}>Nuevo combo</${Button}>
    </div>
    ${r.data && list.length ? html`<div class="toolbar">
      <div class="search search-lg"><${Icon} name="search" size=${18} />
        <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Buscar combo…" aria-label="Buscar combo" /></div>
      <div class="toolbar-info">
        <span><strong>${fmtNum(list.length)}</strong> combos${totals.con != null ? html` · <strong>${fmtNum(totals.con)}</strong> de ${fmtNum(totals.total)} combinaciones con stock` : ''}</span>
        <${Button} size="sm" icon="refresh" loading=${jobSt.loading || !!job} busyText=${job?.progress?.total ? `${job.progress.current}/${job.progress.total}` : 'Actualizando…'} onClick=${() => jobRun()}>Actualizar todos</${Button}>
      </div>
    </div>` : null}
    ${job ? html`<div class="card"><div class="row-between"><strong>${job.label}</strong><span class="muted small">${job.progress?.message || ''}</span></div>
      <${Progress} current=${job.progress?.current} total=${job.progress?.total} label=${job.label} /></div>` : null}
    <${ErrorBox} compact error=${jobSt.error} title="No se pudo iniciar la actualización" onRetry=${() => jobRun()} onClose=${jobSt.reset} />
    ${r.loading ? html`<${SkeletonRows} rows=${3} h=${120} />` : null}
    ${r.error && !r.data ? html`<${ErrorBox} title="No se pudieron cargar los combos" error=${r.error} onRetry=${r.reload} />` : null}
    <${StaleError} r=${r} />
    ${r.data && !list.length ? html`<${Empty} icon="layers" title="Todavía no hay combos">Un combo junta dos productos de Tiendanube (ej. buzo + pantalón) y mantiene el stock de cada combinación de talles.</${Empty}>` : null}
    ${r.data && list.length && !filtered.length ? html`<${Empty} icon="search" title="Ningún combo coincide" />` : null}
    <div class="match-list">${filtered.map(m => html`<${MatchCard} key=${m.id} m=${m} onEdit=${(mm) => setForm({ m: mm })} />`)}</div>
    ${form ? html`<${MatchForm} m=${form.m} onClose=${() => setForm(null)} />` : null}
  </div>`;
}
