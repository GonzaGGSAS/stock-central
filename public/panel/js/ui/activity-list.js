// Feed de actividad agrupado por orden (una venta = una tarjeta con sus productos).
import { html } from '../../vendor/htm-preact-3.1.1.js';
import { fmtDate, fmtDelta, dayKey, dayLabel, fmtNum } from '../lib/format.js';
import { href } from '../lib/router.js';
import { Pill, cx } from './components.js';

const PRIORITY = ['oversold', 'sale', 'return', 'payment_confirmed', 'cart_rejected'];

export function groupActivity(items) {
  const groups = [];
  const byOrder = new Map();
  for (const it of items) {
    if (it.order_id) {
      const g = byOrder.get(String(it.order_id));
      if (g) { g.items.push(it); continue; }
      const ng = { key: 'o:' + it.order_id, order_id: String(it.order_id), ts: it.ts, items: [it] };
      byOrder.set(String(it.order_id), ng);
      groups.push(ng);
    } else groups.push({ key: 'i:' + it.id, ts: it.ts, items: [it] });
  }
  for (const g of groups) {
    g.main = PRIORITY.map(a => g.items.find(i => i.action === a)).find(Boolean) || g.items[0];
    g.client = g.items.find(i => i.client)?.client || '';
    g.order_number = g.items.find(i => i.order_number)?.order_number || '';
    g.email = g.items.find(i => i.email)?.email || '';
    g.tone = g.items.some(i => i.tone === 'bad') ? 'bad' : g.main.tone;
  }
  return groups;
}

function Line({ it, showTag, linkable, hideName }) {
  const name = hideName ? '' : [it.producto, it.variante].filter(Boolean).join(' · ');
  const target = linkable && it.productoId && it.varianteId ? href('stock', { v: `${it.productoId}|${it.varianteId}` }) : null;
  const delta = fmtDelta(it.delta);
  return html`<li class="act-line">
    ${showTag ? html`<${Pill} tone=${it.tone}>${it.title}</${Pill}>` : null}
    <span class="act-what">
      ${name ? (target ? html`<a href=${target}>${name}</a>` : html`<span>${name}</span>`) : null}
      ${it.detail && (!name || it.action !== 'sale') ? html`<span class="muted act-detail" title=${it.detail}>${it.detail}</span>` : null}
    </span>
    ${delta ? html`<span class=${cx('act-delta', Number(it.delta) < 0 ? '' : 'pos')}>${delta}</span>` : null}
    ${it.stock != null && it.stock !== '' ? html`<span class="muted small act-after" title="Stock después del movimiento">quedan ${fmtNum(it.stock)}</span>` : null}
  </li>`;
}

export function ActivityGroup({ g, linkable = true, hideName = false }) {
  const m = g.main;
  return html`<article class=${cx('act', g.tone && 'act-' + g.tone)}>
    <header class="act-head">
      <${Pill} tone=${g.tone || m.tone}>${m.title}</${Pill}>
      ${g.order_id ? html`<span class="act-order" title=${'ID de orden ' + g.order_id}>#${g.order_number || g.order_id}</span>` : null}
      ${g.client ? html`<span class="act-client">${g.client}</span>` : null}
      <time class="muted small act-time" datetime=${g.ts}>${fmtDate(g.ts)}</time>
    </header>
    <ul class="act-lines">
      ${g.items.map((it, i) => html`<${Line} key=${it.id || i} it=${it} linkable=${linkable} hideName=${hideName}
        showTag=${g.items.length > 1 && it.title !== m.title} />`)}
    </ul>
  </article>`;
}

/** Lista con separadores por día. */
export function ActivityFeed({ items, byDay = true, linkable = true, hideName = false }) {
  const groups = groupActivity(items);
  if (!byDay) return html`<div class="act-list">${groups.map(g => html`<${ActivityGroup} key=${g.key} g=${g} linkable=${linkable} hideName=${hideName} />`)}</div>`;
  const out = [];
  let lastDay = null;
  for (const g of groups) {
    const dk = dayKey(g.ts);
    if (dk !== lastDay) { out.push(html`<h3 key=${'d' + dk} class="day-sep">${dayLabel(g.ts)}</h3>`); lastDay = dk; }
    out.push(html`<${ActivityGroup} key=${g.key} g=${g} linkable=${linkable} hideName=${hideName} />`);
  }
  return html`<div class="act-list">${out}</div>`;
}
