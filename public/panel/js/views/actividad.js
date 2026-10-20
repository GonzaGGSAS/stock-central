// Actividad: feed agrupado por orden, filtros, búsqueda y "cargar más".
import { html, useState, useEffect } from '../../vendor/htm-preact-3.1.1.js';
import { api } from '../lib/api.js';
import { useResource } from '../lib/store.js';
import { normActivityItem } from '../lib/normalize.js';
import { setQuery } from '../lib/router.js';
import { Button, ErrorBox, SkeletonRows, Empty, Chip, Refreshing, useDebounced, useAction, StaleError } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { ActivityFeed } from '../ui/activity-list.js';

const CATS = [
  { id: 'all', label: 'Todo' },
  { id: 'sale', label: 'Ventas' },
  { id: 'cart', label: 'Carritos' },
  { id: 'stock', label: 'Ajustes' },
  { id: 'error', label: 'Problemas', tone: 'bad' },
];
const LIMIT = 100;

function qs(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
}

export function Actividad({ query }) {
  const cat = CATS.find(c => c.id === query.c) ? query.c : 'all';
  const [q, setQ] = useState(query.q || '');
  const dq = useDebounced(q.trim(), 300);
  const sync = query.sync === '1';
  const base = { limit: LIMIT, category: cat, q: dq, include_sync: sync ? 1 : 0 };
  const key = 'activity?' + qs(base);
  const r = useResource(key, (signal) => api('/api/activity?' + qs(base), { signal })
    .then(d => ({ items: (d?.items || []).map(normActivityItem), next_before: d?.next_before || null })));
  const [more, setMore] = useState({ key, items: [], next: undefined });

  useEffect(() => { if ((query.q || '') !== dq) setQuery({ q: dq }); }, [dq]);
  useEffect(() => { setMore({ key, items: [], next: undefined }); }, [key]);

  const [loadMore, moreSt] = useAction(async () => {
    const before = more.next !== undefined ? more.next : r.data?.next_before;
    if (!before) return;
    const d = await api('/api/activity?' + qs({ ...base, before }));
    const items = (d?.items || []).map(normActivityItem);
    setMore(m => ({ key, items: [...m.items, ...items], next: d?.next_before || null }));
  });

  // Unimos la primera página (que se refresca sola en vivo) con las páginas extra, sin duplicados.
  const seen = new Set();
  const all = [];
  for (const it of [...(r.data?.items || []), ...(more.key === key ? more.items : [])]) {
    const id = it.id || `${it.ts}|${it.action}|${it.varianteId}`;
    if (seen.has(id)) continue;
    seen.add(id); all.push(it);
  }
  const next = more.key === key && more.next !== undefined ? more.next : r.data?.next_before;

  return html`<div class="view view-actividad">
    <div class="view-head"><h1>Actividad</h1><${Refreshing} on=${r.refreshing} /></div>
    <div class="toolbar">
      <div class="search search-lg">
        <${Icon} name="search" size=${18} />
        <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Buscar cliente, orden, producto…" aria-label="Buscar en actividad" />
        ${q ? html`<button type="button" class="search-x" aria-label="Borrar búsqueda" onClick=${() => setQ('')}><${Icon} name="x" size=${16} /></button>` : null}
      </div>
      <div class="chips" role="group" aria-label="Filtrar por tipo">
        ${CATS.map(c => html`<${Chip} key=${c.id} active=${cat === c.id} tone=${c.tone} onClick=${() => setQuery({ c: c.id === 'all' ? '' : c.id })}>${c.label}</${Chip}>`)}
        <label class="check small"><input type="checkbox" checked=${sync} onChange=${(e) => setQuery({ sync: e.currentTarget.checked ? '1' : '' })} /> Mostrar syncs</label>
      </div>
    </div>
    ${r.loading ? html`<${SkeletonRows} rows=${6} h=${60} />` : null}
    ${r.error && !r.data ? html`<${ErrorBox} title="No se pudo cargar la actividad" error=${r.error} onRetry=${r.reload} />` : null}
    <${StaleError} r=${r} />
    ${r.data && !all.length ? html`<${Empty} icon="activity" title=${dq ? `Nada para “${dq}”` : 'Sin movimientos'}>${cat !== 'all' ? 'Probá con “Todo”.' : null}</${Empty}>` : null}
    ${all.length ? html`<${ActivityFeed} items=${all} />` : null}
    <${ErrorBox} compact error=${moreSt.error} title="No se pudo cargar más" onRetry=${() => loadMore()} />
    ${all.length && next ? html`<div class="more"><${Button} loading=${moreSt.loading} busyText="Cargando…" onClick=${() => loadMore()}>Cargar más</${Button}></div>` : null}
    ${all.length && !next && r.data ? html`<p class="muted small center">No hay más movimientos.</p>` : null}
  </div>`;
}
