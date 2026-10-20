// Normaliza respuestas del backend para que el panel funcione con el contrato nuevo
// (?lite=1) y también con el formato viejo mientras el backend se actualiza.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// ─── Acciones de actividad ───────────────────────────────────────────────────
export const ACTIONS = {
  sale: { title: 'Venta', cat: 'sale', tone: 'ok' },
  return: { title: 'Devolución', cat: 'sale', tone: '' },
  payment_confirmed: { title: 'Pago OK', cat: 'sale', tone: 'ok' },
  cart_added: { title: 'Carrito', cat: 'cart', tone: 'warn' },
  cart_released: { title: 'Carrito liberado', cat: 'cart', tone: '' },
  cart_expired: { title: 'Carrito vencido', cat: 'cart', tone: '' },
  cart_rejected: { title: 'Carrito rechazado', cat: 'error', tone: 'bad' },
  reserved: { title: 'Carrito', cat: 'cart', tone: 'warn' },
  reservation_released: { title: 'Carrito liberado', cat: 'cart', tone: '' },
  reservation_expired: { title: 'Carrito vencido', cat: 'cart', tone: '' },
  set: { title: 'Ajuste', cat: 'stock', tone: '' },
  add: { title: 'Ajuste', cat: 'stock', tone: '' },
  subtract: { title: 'Ajuste', cat: 'stock', tone: '' },
  created: { title: 'Alta', cat: 'stock', tone: '' },
  sanitized: { title: 'Corrección', cat: 'stock', tone: 'warn' },
  reconciled: { title: 'Corregido con TN', cat: 'stock', tone: 'warn' },
  sync: { title: 'Sync', cat: 'sync', tone: '' },
  oversold: { title: 'Sobreventa', cat: 'error', tone: 'bad' },
};

export function actionInfo(action, fallbackTitle) {
  const a = ACTIONS[action];
  return { title: fallbackTitle || a?.title || action || 'Movimiento', cat: a?.cat || 'stock', tone: a?.tone ?? '' };
}

export function normActivityItem(it) {
  const info = actionInfo(it.action, it.title);
  const tone = it.category === 'error' ? 'bad'
    : (it.action === 'sync' && (it.errors?.length || it.error)) ? 'bad'
      : info.tone;
  return { ...it, title: info.title, category: it.category || info.cat, tone };
}

/** Log viejo de una variante (formato db.json) → items de actividad. */
export function legacyLogToActivity(log, ctx = {}) {
  return (log || []).map((l, i) => {
    let detail = l.reason || '';
    if (l.action === 'sync') {
      const errs = Array.isArray(l.errors) ? l.errors : [];
      detail = errs.length
        ? `TN: ${l.links_updated ?? 0} actualizados · ${errs.length} con error (${errs[0]?.error || 'error'})`
        : `TN: ${l.links_updated ?? 0} actualizados`;
    }
    return normActivityItem({
      id: `${ctx.varianteId || ''}:${l.ts}:${l.action}:${i}`,
      ts: l.ts, action: l.action, delta: l.delta, stock: l.stock,
      order_id: l.order_id, detail, errors: l.errors,
      productoId: ctx.productoId, producto: ctx.producto, varianteId: ctx.varianteId, variante: ctx.variante,
    });
  });
}

// ─── Productos / variantes ───────────────────────────────────────────────────
export function normVariante(v, p) {
  const stock = num(v.stock);
  const reservado = v.reservado != null ? num(v.reservado) : 0;
  const disponible = v.disponible != null ? num(v.disponible) : Math.max(0, stock - reservado);
  const out = {
    id: v.id, label: v.label || v.id,
    stock, reservado, disponible,
    links: Array.isArray(v.links) ? v.links : [],
    matchs: v.matchs ?? null,
    last_movement_at: v.last_movement_at ?? (Array.isArray(v.log) && v.log[0]?.ts) ?? null,
    last_sale_at: v.last_sale_at ?? null,
    vendidas_7d: v.vendidas_7d ?? null,
    sync_error: v.sync_error ?? null,
  };
  // Formato viejo (sin lite): guardamos el log para el historial sin pedir más nada.
  if (Array.isArray(v.log)) {
    out.legacyLog = legacyLogToActivity(v.log.slice(0, 200), { productoId: p.id, producto: p.nombre, varianteId: v.id, variante: v.label });
    if (out.sync_error == null) {
      const lastSync = v.log.find(l => l.action === 'sync');
      if (lastSync && Array.isArray(lastSync.errors) && lastSync.errors.length) out.sync_error = lastSync.errors[0].error || 'Falló el último sync';
    }
  }
  return out;
}

export function normProducto(p) {
  const variantes = (p.variantes || []).map(v => normVariante(v, p));
  return {
    id: p.id, nombre: p.nombre || p.id,
    variantes,
    unidades: p.unidades != null ? num(p.unidades) : variantes.reduce((a, v) => a + v.stock, 0),
    disponibles: p.disponibles != null ? num(p.disponibles) : variantes.reduce((a, v) => a + v.disponible, 0),
    sin_stock: p.sin_stock != null ? num(p.sin_stock) : variantes.filter(v => v.disponible <= 0).length,
  };
}

export const normProductos = (list) => (Array.isArray(list) ? list : []).map(normProducto);

/** Recalcula los totales de un producto después de un cambio optimista. */
export function recomputeProducto(p) {
  return {
    ...p,
    unidades: p.variantes.reduce((a, v) => a + v.stock, 0),
    disponibles: p.variantes.reduce((a, v) => a + v.disponible, 0),
    sin_stock: p.variantes.filter(v => v.disponible <= 0).length,
  };
}

// ─── Combos (matchs) ─────────────────────────────────────────────────────────
export function normMatch(m) {
  const legacy = !Array.isArray(m.combos);
  const combos = legacy
    ? (m.variantMap || []).map(vm => ({ label: vm.label, tn_variant_id: vm.tn_variant_id, stock: undefined }))
    : m.combos.map(c => ({ ...c, stock: c.stock == null ? null : num(c.stock) })); // null = sin límite
  const known = combos.filter(c => c.stock !== undefined);
  return {
    id: m.id, nombre: m.nombre, tn_match_product_id: m.tn_match_product_id,
    precio: m.precio ?? null, precio_promocional: m.precio_promocional ?? null, imagen_url: m.imagen_url ?? null,
    producto1: { tn_product_id: m.producto1?.tn_product_id, nombre: m.producto1?.nombre || 'Producto 1' },
    producto2: { tn_product_id: m.producto2?.tn_product_id, nombre: m.producto2?.nombre || 'Producto 2' },
    combos,
    combos_total: m.combos_total != null ? num(m.combos_total) : combos.length,
    combos_con_stock: m.combos_con_stock != null ? num(m.combos_con_stock) : (known.length ? known.filter(c => c.stock === null || c.stock > 0).length : null),
    legacy,
  };
}
export const normMatchs = (list) => (Array.isArray(list) ? list : []).map(normMatch);

// ─── Productos de Tiendanube ─────────────────────────────────────────────────
export const tnText = (v) => (v == null ? '' : typeof v === 'object' ? (v.es || v.en || v.pt || Object.values(v)[0] || '') : String(v));
export const tnVariantLabel = (v) => (v.values || []).map(tnText).filter(Boolean).join(' / ') || v.sku || `Variante ${v.id}`;
