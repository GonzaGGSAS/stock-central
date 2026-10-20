// Inicio: alertas arriba, números grandes, salud de la conexión y actividad reciente.
import { html, useEffect, useState } from '../../vendor/htm-preact-3.1.1.js';
import { api } from '../lib/api.js';
import { useResource, mutateResource, invalidate, useStore } from '../lib/store.js';
import { fmtDate, fmtNum, plural } from '../lib/format.js';
import { normActivityItem } from '../lib/normalize.js';
import { href } from '../lib/router.js';
import { ingestJobs, jobsStore, runningJobs } from '../lib/jobs.js';
import { Button, ErrorBox, Skeleton, SkeletonRows, Empty, Refreshing, Progress, StaleError, cx } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { toast } from '../ui/overlay.js';
import { ActivityFeed } from '../ui/activity-list.js';
import { storeInfo } from '../lib/store-info.js';

const ALERT_TYPES = {
  oversold: 'Sobreventa', unlinked_sale: 'Venta sin vincular', sync_error: 'Error de sync',
  cart_rejected: 'Carrito rechazado', webhook_error: 'Error de webhook', discrepancy: 'Diferencia con TN',
};

function alertLink(a) {
  if (a.productoId && a.varianteId) return { href: href('stock', { v: `${a.productoId}|${a.varianteId}` }), label: 'Ver variante' };
  if (a.order_id) return { href: href('actividad', { q: a.order_id }), label: 'Ver orden' };
  if (a.type === 'unlinked_sale') return { href: href('stock'), label: 'Ir a Stock' };
  return null;
}

function AlertCard({ a, onDismiss }) {
  const [state, setState] = useState({ busy: false, error: null });
  const link = alertLink(a);
  const tone = a.severity === 'warning' ? 'warn' : 'bad';
  const dismiss = async () => {
    setState({ busy: true, error: null });
    try { await onDismiss(a); }
    catch (e) { setState({ busy: false, error: e }); }
  };
  return html`<li class=${cx('alert', 'alert-' + tone)}>
    <${Icon} name="alert" size=${20} />
    <div class="alert-body">
      <div class="alert-top">
        <span class="alert-type">${ALERT_TYPES[a.type] || 'Alerta'}</span>
        ${a.count > 1 ? html`<span class="alert-count" title="Veces que pasó">×${a.count}</span>` : null}
        <time class="muted small" datetime=${a.ts}>${fmtDate(a.ts)}</time>
      </div>
      <strong class="alert-title">${a.title}</strong>
      ${a.detail ? html`<p class="alert-detail">${a.detail}</p>` : null}
      ${state.error ? html`<${ErrorBox} compact error=${state.error} onRetry=${dismiss} />` : null}
    </div>
    <div class="alert-actions">
      ${link ? html`<a class="btn btn-sm" href=${link.href}>${link.label}</a>` : null}
      <${Button} size="sm" kind="ghost" loading=${state.busy} onClick=${dismiss}>Descartar</${Button}>
    </div>
  </li>`;
}

function Alerts() {
  const r = useResource('alerts', (signal) => api('/api/alerts?include_dismissed=0', { signal }));
  const [allBusy, setAllBusy] = useState(false);
  const [allErr, setAllErr] = useState(null);
  const list = Array.isArray(r.data) ? r.data.filter(a => !a.dismissed) : [];

  const dismiss = async (a) => {
    await api(`/api/alerts/${encodeURIComponent(a.id)}/dismiss`, { method: 'POST' });
    mutateResource('alerts', l => Array.isArray(l) ? l.filter(x => x.id !== a.id) : l);
    invalidate('overview');
  };
  const dismissAll = async () => {
    setAllBusy(true); setAllErr(null);
    try {
      await api('/api/alerts/dismiss-all', { method: 'POST' });
      mutateResource('alerts', []);
      invalidate('overview');
      toast('Alertas descartadas');
    } catch (e) { setAllErr(e); } finally { setAllBusy(false); }
  };

  if (r.loading) return html`<section class="card" aria-busy="true"><${Skeleton} h=${18} w="40%" /><div class="gap"></div><${SkeletonRows} rows=${1} h=${64} /></section>`;
  if (r.error && !r.data) return html`<section class="card"><${ErrorBox} title="No se pudieron cargar las alertas" error=${r.error} onRetry=${r.reload} /></section>`;
  if (!list.length) {
    return html`<section class="allok" aria-live="polite"><${Icon} name="check" /><span><strong>Sin alertas.</strong> No hay sobreventas, errores de sync ni ventas sin vincular.</span><${Refreshing} on=${r.refreshing} /></section>`;
  }
  return html`<section class="alerts" aria-labelledby="alerts-h">
    <div class="sec-head">
      <h2 id="alerts-h"><span class="dot dot-bad"></span>Alertas <span class="count-badge tone-bad">${list.length}</span></h2>
      <${Refreshing} on=${r.refreshing} />
      ${list.length > 1 ? html`<${Button} size="sm" kind="ghost" loading=${allBusy} onClick=${dismissAll}>Descartar todas</${Button}>` : null}
    </div>
    <${ErrorBox} compact error=${allErr} onRetry=${dismissAll} />
    <${StaleError} r=${r} />
    <ul class="alert-list">${list.map(a => html`<${AlertCard} key=${a.id} a=${a} onDismiss=${dismiss} />`)}</ul>
  </section>`;
}

function Stat({ label, value, sub, tone, to, big }) {
  const inner = html`
    <span class="stat-label">${tone ? html`<span class=${'dot dot-' + tone}></span>` : null}${label}</span>
    <span class=${cx('stat-value', tone && Number(value) > 0 && 'tone-' + tone)}>${value == null ? '—' : fmtNum(value)}</span>
    ${sub ? html`<span class="stat-sub">${sub}</span>` : null}`;
  return to
    ? html`<a class=${cx('stat', big && 'stat-big')} href=${to}>${inner}<${Icon} name="chevron" size=${16} class="stat-go" /></a>`
    : html`<div class=${cx('stat', big && 'stat-big')}>${inner}</div>`;
}

function Kpis({ r }) {
  if (r.loading) {
    return html`<div class="stats" aria-busy="true" aria-label="Cargando números">
      ${[0, 1, 2, 3, 4, 5].map(i => html`<div class="stat" key=${i}><${Skeleton} h=${12} w="50%" /><${Skeleton} h=${34} w="40%" /><${Skeleton} h=${10} w="60%" /></div>`)}
    </div>`;
  }
  if (r.error && !r.data) return html`<${ErrorBox} title="No se pudieron cargar los números" error=${r.error} onRetry=${r.reload} />`;
  const k = r.data?.kpis || {};
  return html`<${StaleError} r=${r} /><div class="stats">
    <${Stat} big label="Unidades en stock" value=${k.unidades} tone="ok"
      sub=${`${plural(k.productos ?? 0, 'producto', 'productos')} · ${plural(k.variantes ?? 0, 'variante', 'variantes')}`} to=${href('stock')} />
    <${Stat} label="Sin stock" value=${k.sin_stock} tone="bad" sub="variantes en 0" to=${href('stock', { f: 'sin' })} />
    <${Stat} label="Stock bajo" value=${k.stock_bajo} tone="warn" sub="variantes con 1 a 3" to=${href('stock', { f: 'bajo' })} />
    <${Stat} label="En carritos" value=${k.unidades_reservadas} tone="warn"
      sub=${plural(k.reservas_activas ?? 0, 'carrito activo', 'carritos activos')} to=${href('stock', { f: 'carrito' })} />
    <${Stat} label="Vendidas hoy" value=${k.unidades_vendidas_hoy} tone="ok"
      sub=${plural(k.ventas_hoy ?? 0, 'venta', 'ventas')} to=${href('actividad', { c: 'sale' })} />
    <${Stat} label="Vendidas 7 días" value=${k.unidades_vendidas_7d} tone="ok" sub="unidades" to=${href('actividad', { c: 'sale' })} />
  </div>`;
}

function Health({ h }) {
  if (!h) return null;
  if (!h.tn_configured) {
    return html`<div class="banner banner-bad" role="alert"><${Icon} name="alert" />
      <span><strong>Tiendanube no está conectado.</strong> Sin credenciales no se actualiza el stock de la tienda.</span>
      <a class="btn btn-sm" href=${href('ajustes')}>Conectar</a></div>`;
  }
  const items = [
    { ok: true, label: 'Tiendanube conectado' },
    { ok: !!h.webhooks_registered, label: h.webhooks_registered ? 'Webhooks activos' : 'Webhooks sin registrar', to: h.webhooks_registered ? null : href('ajustes') },
    { ok: true, neutral: true, label: `Último pedido recibido: ${h.last_webhook_at ? fmtDate(h.last_webhook_at) : 'nunca'}` },
    { ok: true, neutral: true, label: `Última reconciliación: ${h.last_reconcile_at ? fmtDate(h.last_reconcile_at) : 'nunca'}` },
  ];
  return html`<ul class="health">
    ${items.map((it, i) => html`<li key=${i}>
      <span class=${'dot ' + (it.neutral ? 'dot-n' : it.ok ? 'dot-ok' : 'dot-bad')}></span>
      ${it.to ? html`<a href=${it.to}>${it.label}</a>` : html`<span>${it.label}</span>`}
    </li>`)}
  </ul>`;
}

function RunningJobs() {
  const jobs = useStore(jobsStore, runningJobs);
  if (!jobs.length) return null;
  return html`<section class="card">
    <div class="sec-head"><h2>Tareas en curso</h2><a class="btn btn-sm btn-ghost" href=${href('ajustes')}>Ver</a></div>
    ${jobs.map(j => html`<div class="job-mini" key=${j.id}>
      <div class="row-between"><strong>${j.label}</strong><span class="muted small">${j.progress?.total ? `${j.progress.current}/${j.progress.total}` : 'arrancando…'}</span></div>
      <${Progress} current=${j.progress?.current} total=${j.progress?.total} label=${j.label} />
      ${j.progress?.message ? html`<span class="muted small">${j.progress.message}</span>` : null}
    </div>`)}
  </section>`;
}

function Recent() {
  const r = useResource('activity:recent', (signal) => api('/api/activity?limit=15&include_sync=0', { signal })
    .then(d => (d?.items || []).map(normActivityItem)));
  return html`<section class="card">
    <div class="sec-head"><h2>Actividad reciente</h2><${Refreshing} on=${r.refreshing} /><a class="btn btn-sm btn-ghost" href=${href('actividad')}>Ver toda</a></div>
    ${r.loading ? html`<${SkeletonRows} rows=${4} h=${52} />` : null}
    ${r.error && !r.data ? html`<${ErrorBox} title="No se pudo cargar la actividad" error=${r.error} onRetry=${r.reload} />` : null}
    ${r.data && !r.data.length ? html`<${Empty} icon="activity" title="Todavía no hay movimientos" />` : null}
    <${StaleError} r=${r} />
    ${r.data?.length ? html`<${ActivityFeed} items=${r.data.slice(0, 15)} byDay=${false} />` : null}
  </section>`;
}

export function Inicio() {
  const ov = useResource('overview', (signal) => api('/api/overview', { signal }));
  useEffect(() => {
    if (!ov.data) return;
    ingestJobs(ov.data.jobs);
    if (ov.data.store) {
      const clean = Object.fromEntries(Object.entries(ov.data.store).filter(([, v]) => v));
      const cur = storeInfo.get();
      if (Object.keys(clean).some(k => cur[k] !== clean[k])) storeInfo.set(s => ({ ...s, ...clean }));
    }
  }, [ov.data]);
  return html`<div class="view view-inicio">
    <div class="view-head">
      <h1>Inicio</h1>
      <${Refreshing} on=${ov.refreshing} />
    </div>
    <${Alerts} />
    <${Health} h=${ov.data?.health} />
    <${Kpis} r=${ov} />
    <${RunningJobs} />
    <${Recent} />
  </div>`;
}
