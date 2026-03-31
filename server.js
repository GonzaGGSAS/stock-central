/**
 * STOCK CENTRAL v2 + Reservas - Backend para Tiendanube
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fs = require('fs');

if (!fs.existsSync('./data')) fs.mkdirSync('./data');

const adapter = new FileSync('./data/db.json');
const db = low(adapter);

db.defaults({
  config: { access_token: '', store_id: '', webhook_registered: false },
  productos: [],
  reservations: [] // { id, sessionId, productoId, varianteId, qty, expiresAt }
}).write();

const app = express();
app.use(cors());
app.use(bodyParser.json());
const PORT = process.env.PORT || 3001;
const RESERVATION_MS = 30 * 60 * 1000; // 30 minutos

// ─── Helper: API Tiendanube ──────────────────────────────────────────────────
async function tnRequest(method, path, body = null) {
  const { access_token, store_id } = db.get('config').value();
  if (!access_token || !store_id) throw new Error('No configurado');
  const fetch = (await import('node-fetch')).default;
  const res = await fetch(`https://api.tiendanube.com/2025-03/${store_id}${path}`, {
    method,
    headers: { 'Authentication': `bearer ${access_token}`, 'Content-Type': 'application/json', 'User-Agent': 'StockCentral (soporte@minch.com.ar)' },
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.description || `API error ${res.status}`);
  return data;
}

// ─── Helper: Sync variante a Tiendanube ─────────────────────────────────────
async function syncVariante(productoId, varianteId) {
  const prod = db.get('productos').find({ id: productoId }).value();
  if (!prod) throw new Error('Producto no encontrado');
  const variante = prod.variantes.find(v => v.id === varianteId);
  if (!variante) throw new Error('Variante no encontrada');
  const errors = [];
  for (const link of variante.links) {
    try {
      await tnRequest('PUT', `/products/${link.product_id}/variants/${link.variant_id}`, { stock: variante.stock });
    } catch (e) { errors.push({ variant_id: link.variant_id, error: e.message }); }
  }
  db.get('productos').find({ id: productoId }).get('variantes').find({ id: varianteId }).get('log').unshift({
    ts: new Date().toISOString(), action: 'sync', stock: variante.stock,
    links_updated: variante.links.length - errors.length, errors
  }).write();
  return { ok: true, updated: variante.links.length - errors.length, errors };
}

// ─── Helper: stock disponible (descontando reservas activas) ─────────────────
function getAvailableStock(productoId, varianteId) {
  const prod = db.get('productos').find({ id: productoId }).value();
  if (!prod) return 0;
  const variante = prod.variantes.find(v => v.id === varianteId);
  if (!variante) return 0;
  const now = Date.now();
  const reservado = db.get('reservations')
    .filter(r => r.productoId === productoId && r.varianteId === varianteId && r.expiresAt > now)
    .reduce((acc, r) => acc + r.qty, 0)
    .value();
  return Math.max(0, variante.stock - reservado);
}

// ─── Cron: liberar reservas expiradas cada 60 seg ───────────────────────────
setInterval(async () => {
  const now = Date.now();
  const expired = db.get('reservations').filter(r => r.expiresAt <= now).value();
  if (expired.length === 0) return;
  console.log(`[RESERVAS] Liberando ${expired.length} reserva(s) expirada(s)...`);
  for (const r of expired) {
    const prod = db.get('productos').find({ id: r.productoId }).value();
    if (!prod) continue;
    const variante = prod.variantes.find(v => v.id === r.varianteId);
    if (!variante) continue;
    const newStock = variante.stock + r.qty;
    db.get('productos').find({ id: r.productoId }).get('variantes').find({ id: r.varianteId })
      .assign({ stock: newStock }).get('log').unshift({
        ts: new Date().toISOString(), action: 'reservation_expired',
        reservation_id: r.id, delta: +r.qty, stock: newStock,
        reason: 'Reserva expirada (30 min sin pago)'
      }).write();
    syncVariante(r.productoId, r.varianteId).catch(e => console.error('[RESERVAS] Sync error:', e.message));
    console.log(`[RESERVAS] ${r.productoId}/${r.varianteId}: stock restaurado → ${newStock}`);
  }
  db.get('reservations').remove(r => r.expiresAt <= now).write();
}, 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
// Config
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  const c = db.get('config').value();
  res.json({ store_id: c.store_id, has_token: !!c.access_token, webhook_registered: c.webhook_registered });
});
app.post('/api/config', (req, res) => {
  const { access_token, store_id } = req.body;
  if (!access_token || !store_id) return res.status(400).json({ error: 'Faltan datos' });
  db.set('config.access_token', access_token).set('config.store_id', store_id).write();
  res.json({ ok: true });
});
app.post('/api/config/test', async (req, res) => {
  try { await tnRequest('GET', '/products?per_page=1'); res.json({ ok: true, store_name: 'Tienda conectada OK' }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/config/webhook', async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Falta webhook_url' });
  try {
    await tnRequest('POST', '/webhooks', { event: 'order/paid', url: `${webhook_url}/webhook/order` });
    await tnRequest('POST', '/webhooks', { event: 'order/cancelled', url: `${webhook_url}/webhook/order` });
    db.set('config.webhook_registered', true).write();
    res.json({ ok: true, message: 'Webhooks registrados' });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Productos
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/productos', (req, res) => res.json(db.get('productos').value()));

app.post('/api/productos', (req, res) => {
  const { id, nombre } = req.body;
  if (!id || !nombre) return res.status(400).json({ error: 'Faltan id o nombre' });
  const slug = id.toUpperCase().replace(/\s+/g, '_');
  if (db.get('productos').find({ id: slug }).value()) return res.status(409).json({ error: 'Ya existe' });
  const nuevo = { id: slug, nombre, variantes: [] };
  db.get('productos').push(nuevo).write();
  res.json(nuevo);
});

app.delete('/api/productos/:id', (req, res) => {
  db.get('productos').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.post('/api/productos/:id/sync', async (req, res) => {
  try {
    const prod = db.get('productos').find({ id: req.params.id }).value();
    if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
    const results = [];
    for (const v of prod.variantes) {
      const r = await syncVariante(req.params.id, v.id);
      results.push({ variante: v.label, ...r });
    }
    res.json({ ok: true, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Variantes internas
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/productos/:id/variantes', (req, res) => {
  const { label, stock } = req.body;
  if (!label) return res.status(400).json({ error: 'Falta label' });
  const prod = db.get('productos').find({ id: req.params.id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const varId = `var_${Date.now()}`;
  const nueva = { id: varId, label, stock: parseInt(stock) || 0, links: [], log: [{ ts: new Date().toISOString(), action: 'created', stock: parseInt(stock) || 0 }] };
  db.get('productos').find({ id: req.params.id }).get('variantes').push(nueva).write();
  res.json(nueva);
});

app.put('/api/productos/:id/variantes/:varId/stock', async (req, res) => {
  const { id, varId } = req.params;
  const { delta, absolute, reason, sync } = req.body;
  const prod = db.get('productos').find({ id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const variante = prod.variantes.find(v => v.id === varId);
  if (!variante) return res.status(404).json({ error: 'Variante no encontrada' });
  let newStock = absolute !== undefined ? parseInt(absolute) : variante.stock + parseInt(delta);
  if (newStock < 0) newStock = 0;
  db.get('productos').find({ id }).get('variantes').find({ id: varId })
    .assign({ stock: newStock }).get('log').unshift({
      ts: new Date().toISOString(), action: absolute !== undefined ? 'set' : delta > 0 ? 'add' : 'subtract',
      delta: delta || (newStock - variante.stock), stock: newStock, reason: reason || ''
    }).write();
  let syncResult = null;
  if (sync) { try { syncResult = await syncVariante(id, varId); } catch (e) { syncResult = { ok: false, error: e.message }; } }
  res.json({ ok: true, stock: newStock, sync: syncResult });
});

app.delete('/api/productos/:id/variantes/:varId', (req, res) => {
  db.get('productos').find({ id: req.params.id }).get('variantes').remove({ id: req.params.varId }).write();
  res.json({ ok: true });
});

app.post('/api/productos/:id/variantes/:varId/sync', async (req, res) => {
  try { res.json(await syncVariante(req.params.id, req.params.varId)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Links a Tiendanube
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/productos/:id/variantes/:varId/links', (req, res) => {
  const { id, varId } = req.params;
  const { product_id, variant_id, label } = req.body;
  if (!product_id || !variant_id) return res.status(400).json({ error: 'Faltan datos' });
  const prod = db.get('productos').find({ id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });
  const variante = prod.variantes.find(v => v.id === varId);
  if (!variante) return res.status(404).json({ error: 'Variante no encontrada' });
  if (variante.links.find(l => l.variant_id === String(variant_id))) return res.status(409).json({ error: 'Ya vinculada' });
  db.get('productos').find({ id }).get('variantes').find({ id: varId }).get('links').push({
    product_id: String(product_id), variant_id: String(variant_id), label: label || `P:${product_id} V:${variant_id}`
  }).write();
  res.json({ ok: true });
});

app.delete('/api/productos/:id/variantes/:varId/links/:variant_id', (req, res) => {
  const { id, varId, variant_id } = req.params;
  db.get('productos').find({ id }).get('variantes').find({ id: varId }).get('links').remove({ variant_id }).write();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// Reservas de carrito
// ════════════════════════════════════════════════════════════════════════════

// POST /api/reserve — el storefront llama esto cuando agrega al carrito
app.post('/api/reserve', async (req, res) => {
  const { sessionId, variant_id, qty = 1 } = req.body;
  if (!sessionId || !variant_id) return res.status(400).json({ error: 'Faltan sessionId o variant_id' });

  // Buscar la variante interna que tenga este link
  const productos = db.get('productos').value();
  let foundProd = null, foundVar = null;
  for (const p of productos) {
    for (const v of p.variantes) {
      if (v.links.some(l => l.variant_id === String(variant_id))) { foundProd = p; foundVar = v; break; }
    }
    if (foundProd) break;
  }

  if (!foundProd || !foundVar) {
    return res.json({ ok: true, managed: false, reason: 'Variante no gestionada por Stock Central' });
  }

  const now = Date.now();
  const available = getAvailableStock(foundProd.id, foundVar.id);

  if (available < qty) {
    return res.status(409).json({ ok: false, error: 'Stock insuficiente', available });
  }

  // Verificar si ya existe reserva activa para esta sesion Y este variant_id especifico de TN
  const existing = db.get('reservations')
    .find(r => r.sessionId === sessionId && r.tnVariantId === String(variant_id) && r.expiresAt > now)
    .value();

  if (existing) {
    // Sumar al stock reservado (misma prenda, misma sesion, mas unidades)
    const extraQty = parseInt(qty);
    const newQty = existing.qty + extraQty;
    const newStock = foundVar.stock - extraQty;

    db.get('reservations').find({ id: existing.id })
      .assign({ qty: newQty, expiresAt: now + RESERVATION_MS }).write();

    db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
      .assign({ stock: newStock }).get('log').unshift({
        ts: new Date().toISOString(), action: 'reserved',
        reservation_id: existing.id, session_id: sessionId,
        delta: -extraQty, stock: newStock, reason: 'Reserva acumulada (mas unidades)'
      }).write();

    syncVariante(foundProd.id, foundVar.id).catch(e => console.error('[RESERVAS] Sync error:', e.message));

    console.log(`[RESERVAS] Acumulada: sesion ${sessionId} tnVariant ${variant_id} qty ${existing.qty}+${extraQty}=${newQty} | stock → ${newStock}`);
    return res.json({ ok: true, managed: true, reservation_id: existing.id, updated: true });
  }

  // Nueva reserva — descontar del stock central
  const reservationId = `res_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const newStock = foundVar.stock - parseInt(qty);

  db.get('reservations').push({
    id: reservationId, sessionId,
    productoId: foundProd.id, varianteId: foundVar.id,
    tnVariantId: String(variant_id),
    qty: parseInt(qty), expiresAt: now + RESERVATION_MS
  }).write();

  db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
    .assign({ stock: newStock }).get('log').unshift({
      ts: new Date().toISOString(), action: 'reserved',
      reservation_id: reservationId, session_id: sessionId,
      delta: -parseInt(qty), stock: newStock, reason: 'Reserva de carrito (30 min)'
    }).write();

  console.log(`[RESERVAS] Nueva: sesion ${sessionId} ${foundProd.nombre}/${foundVar.label} qty ${qty} | stock ${foundVar.stock} → ${newStock}`);

  // Sync a Tiendanube en background
  syncVariante(foundProd.id, foundVar.id).catch(e => console.error('[RESERVAS] Sync error:', e.message));

  res.json({ ok: true, managed: true, reservation_id: reservationId });
});

// DELETE /api/reserve/:sessionId — liberar reserva (cliente vacía carrito)
app.delete('/api/reserve/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const { variant_id } = req.query;
  const now = Date.now();

  let toRelease;
  if (variant_id) {
    // Buscar productoId/varianteId por variant_id de TN
    const productos = db.get('productos').value();
    let foundProd = null, foundVar = null;
    for (const p of productos) {
      for (const v of p.variantes) {
        if (v.links.some(l => l.variant_id === String(variant_id))) { foundProd = p; foundVar = v; break; }
      }
      if (foundProd) break;
    }
    if (!foundVar) return res.json({ ok: true, released: 0 });
    toRelease = db.get('reservations')
      .filter(r => r.sessionId === sessionId && r.varianteId === foundVar.id && r.expiresAt > now)
      .value();
  } else {
    toRelease = db.get('reservations')
      .filter(r => r.sessionId === sessionId && r.expiresAt > now)
      .value();
  }

  if (toRelease.length === 0) return res.json({ ok: true, released: 0 });

  for (const r of toRelease) {
    const prod = db.get('productos').find({ id: r.productoId }).value();
    if (!prod) continue;
    const variante = prod.variantes.find(v => v.id === r.varianteId);
    if (!variante) continue;
    const newStock = variante.stock + r.qty;
    db.get('productos').find({ id: r.productoId }).get('variantes').find({ id: r.varianteId })
      .assign({ stock: newStock }).get('log').unshift({
        ts: new Date().toISOString(), action: 'reservation_released',
        reservation_id: r.id, delta: +r.qty, stock: newStock, reason: 'Reserva liberada'
      }).write();
    syncVariante(r.productoId, r.varianteId).catch(e => console.error('[RESERVAS] Sync error:', e.message));
  }

  if (variant_id) {
    db.get('reservations').remove(r => r.sessionId === sessionId && toRelease.some(t => t.id === r.id)).write();
  } else {
    db.get('reservations').remove({ sessionId }).write();
  }

  console.log(`[RESERVAS] Liberadas ${toRelease.length} reserva(s) de sesion ${sessionId}`);
  res.json({ ok: true, released: toRelease.length });
});

// ════════════════════════════════════════════════════════════════════════════
// TN Products list
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/tn-products', async (req, res) => {
  try {
    let all = [], page = 1;
    while (true) {
      const batch = await tnRequest('GET', `/products?per_page=50&page=${page}&fields=id,name,variants`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < 50) break;
      page++;
    }
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// Webhook de órdenes
// ════════════════════════════════════════════════════════════════════════════

app.post('/webhook/order', async (req, res) => {
  res.sendStatus(200);
  const { event, id: order_id, store_id } = req.body;
  console.log(`[WEBHOOK] ${event} | Orden: ${order_id}`);
  try {
    const fetch = (await import('node-fetch')).default;
    const { access_token } = db.get('config').value();
    const orderRes = await fetch(`https://api.tiendanube.com/2025-03/${store_id}/orders/${order_id}`, {
      headers: { 'Authentication': `bearer ${access_token}`, 'User-Agent': 'StockCentral (soporte@minch.com.ar)' }
    });
    const order = await orderRes.json();

    for (const item of order.products || []) {
      const { variant_id, quantity } = item;
      const productos = db.get('productos').value();
      let foundProd = null, foundVar = null;
      for (const p of productos) {
        for (const v of p.variantes) {
          if (v.links.some(l => l.variant_id === String(variant_id))) { foundProd = p; foundVar = v; break; }
        }
        if (foundProd) break;
      }
      if (!foundProd || !foundVar) {
        console.log(`[WEBHOOK] variant_id ${variant_id} no gestionada. Ignorado.`);
        continue;
      }

      if (event === 'order/paid') {
        // Buscar reserva activa y limpiarla (el stock ya fue descontado al reservar)
        const now = Date.now();
        const activeRes = db.get('reservations')
          .filter(r => r.productoId === foundProd.id && r.varianteId === foundVar.id && r.expiresAt > now)
          .value();

        if (activeRes.length > 0) {
          const match = activeRes.find(r => r.qty === quantity) || activeRes[0];
          db.get('reservations').remove({ id: match.id }).write();
          db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
            .get('log').unshift({
              ts: new Date().toISOString(), action: 'sale',
              order_id: String(order_id), reservation_id: match.id,
              delta: -quantity, stock: foundVar.stock, reason: 'Venta confirmada (reserva existente)'
            }).write();
          console.log(`[WEBHOOK] Reserva ${match.id} convertida en venta (orden ${order_id})`);
        } else {
          // Sin reserva previa: descontar directamente
          const newStock = Math.max(0, foundVar.stock - quantity);
          db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
            .assign({ stock: newStock }).get('log').unshift({
              ts: new Date().toISOString(), action: 'sale',
              order_id: String(order_id), delta: -quantity, stock: newStock, reason: 'Venta sin reserva previa'
            }).write();
          await syncVariante(foundProd.id, foundVar.id);
          console.log(`[WEBHOOK] ${foundProd.nombre}/${foundVar.label}: ${foundVar.stock} → ${newStock}`);
        }

      } else if (event === 'order/cancelled') {
        const newStock = foundVar.stock + quantity;
        db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
          .assign({ stock: newStock }).get('log').unshift({
            ts: new Date().toISOString(), action: 'return',
            order_id: String(order_id), delta: +quantity, stock: newStock
          }).write();
        await syncVariante(foundProd.id, foundVar.id);
      }
    }
  } catch (e) { console.error('[WEBHOOK] Error:', e.message); }
});

app.post('/webhook/privacy', (req, res) => res.sendStatus(200));

// ════════════════════════════════════════════════════════════════════════════
// Stats
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/stats', (req, res) => {
  const productos = db.get('productos').value();
  const todasVariantes = productos.flatMap(p => p.variantes.map(v => ({ ...v, producto: p.nombre })));
  const now = Date.now();
  const activeReservations = db.get('reservations').filter(r => r.expiresAt > now).value();
  res.json({
    total_productos: productos.length,
    total_variantes: todasVariantes.length,
    total_links: todasVariantes.reduce((a, v) => a + v.links.length, 0),
    stock_bajo: todasVariantes.filter(v => v.stock <= 5 && v.stock > 0).length,
    sin_stock: todasVariantes.filter(v => v.stock === 0).length,
    active_reservations: activeReservations.length,
    recent_log: todasVariantes.flatMap(v => v.log.slice(0, 2).map(l => ({ ...l, producto: v.producto, variante: v.label })))
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()).slice(0, 20)
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Start
// ════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Stock Central v2 + Reservas en puerto ${PORT}`);
  if (process.env.ACCESS_TOKEN && process.env.STORE_ID) {
    db.set('config.access_token', process.env.ACCESS_TOKEN).set('config.store_id', process.env.STORE_ID).write();
    console.log(`Credenciales cargadas: store ${process.env.STORE_ID}`);
  }
});
