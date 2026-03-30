/**
 * STOCK CENTRAL - Backend para Tiendanube
 * ========================================
 * Gestiona stock compartido entre múltiples productos/variantes
 * por medio de SKU como identificador central.
 *
 * CONFIGURACIÓN:
 *   1. npm install
 *   2. node server.js
 *   3. Exponer puerto 3001 con ngrok o deployar en Railway/Render
 *   4. Registrar webhook en Tiendanube apuntando a: https://TU_URL/webhook/order
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { v4: uuidv4 } = require('uuid'); // ─── NUEVO: para generar IDs de reserva

// ─── Base de datos local (JSON file) ────────────────────────────────────────
const adapter = new FileSync('./data/db.json');
const db = low(adapter);

db.defaults({
  config: {
    access_token: '',
    store_id: '',
    webhook_registered: false
  },
  skus: [],        // { sku, stock_central, variants: [{product_id, variant_id, label}], log: [] }
  reservations: [] // ─── NUEVO: { id, sessionId, sku, qty, expiresAt }
}).write();

// ─── App Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json());
const path = require('path');
app.use('/static', express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3001;
const RESERVATION_DURATION_MS = 30 * 60 * 1000; // ─── NUEVO: 30 minutos

// ─── NUEVO: Helper para calcular stock disponible real (descontando reservas activas) ──
function getAvailableStock(sku) {
  const skuData = db.get('skus').find({ sku }).value();
  if (!skuData) return 0;

  const now = Date.now();
  const reservedQty = db.get('reservations')
    .filter(r => r.sku === sku && r.expiresAt > now)
    .reduce((acc, r) => acc + r.qty, 0)
    .value();

  return Math.max(0, skuData.stock_central - reservedQty);
}

// ─── NUEVO: Cron job — liberar reservas expiradas cada 60 segundos ────────────
setInterval(() => {
  const now = Date.now();
  const expired = db.get('reservations').filter(r => r.expiresAt <= now).value();

  if (expired.length === 0) return;

  console.log(`[RESERVAS] Liberando ${expired.length} reserva(s) expirada(s)...`);

  for (const reservation of expired) {
    const skuData = db.get('skus').find({ sku: reservation.sku }).value();
    if (!skuData) continue;

    const newStock = skuData.stock_central + reservation.qty;

    db.get('skus').find({ sku: reservation.sku })
      .assign({ stock_central: newStock })
      .get('log').unshift({
        ts: new Date().toISOString(),
        action: 'reservation_expired',
        reservation_id: reservation.id,
        delta: +reservation.qty,
        stock: newStock,
        reason: 'Reserva expirada (30 min sin pago)'
      }).write();

    console.log(`[RESERVAS] SKU ${reservation.sku}: stock restaurado de ${skuData.stock_central} → ${newStock}`);
  }

  // Eliminar todas las reservas expiradas
  db.get('reservations').remove(r => r.expiresAt <= now).write();
}, 60 * 1000);

// ─── Helper: llamar a la API de Tiendanube ───────────────────────────────────
async function tiendanubeRequest(method, path, body = null) {
  const { access_token, store_id } = db.get('config').value();
  if (!access_token || !store_id) throw new Error('No configurado: falta access_token o store_id');

  const url = `https://api.tiendanube.com/2025-03/${store_id}${path}`;
  const opts = {
    method,
    headers: {
      'Authentication': `bearer ${access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'StockCentral (soporte@tuapp.com)'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const fetch = (await import('node-fetch')).default;
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.description || `API error ${res.status}`);
  return data;
}

// ─── Helper: pushear stock de un SKU a todas sus variantes vinculadas ────────
async function syncSkuToTiendanube(sku) {
  const skuData = db.get('skus').find({ sku }).value();
  if (!skuData) throw new Error(`SKU ${sku} no encontrado`);

  const { stock_central, variants } = skuData;
  const errors = [];

  for (const v of variants) {
    try {
      await tiendanubeRequest('PUT', `/products/${v.product_id}/variants/${v.variant_id}`, {
        stock: stock_central
      });
    } catch (err) {
      errors.push({ variant_id: v.variant_id, error: err.message });
    }
  }

  // Log
  db.get('skus').find({ sku }).get('log').unshift({
    ts: new Date().toISOString(),
    action: 'sync',
    stock: stock_central,
    variants_updated: variants.length - errors.length,
    errors
  }).write();

  return { ok: true, updated: variants.length - errors.length, errors };
}

// ─── RUTAS: Configuración ────────────────────────────────────────────────────

// GET /api/config
app.get('/api/config', (req, res) => {
  const config = db.get('config').value();
  res.json({
    store_id: config.store_id,
    has_token: !!config.access_token,
    webhook_registered: config.webhook_registered
  });
});

// POST /api/config
app.post('/api/config', (req, res) => {
  const { access_token, store_id } = req.body;
  if (!access_token || !store_id) return res.status(400).json({ error: 'Falta access_token o store_id' });

  db.set('config.access_token', access_token)
    .set('config.store_id', store_id)
    .write();

  res.json({ ok: true });
});

// POST /api/config/test
app.post('/api/config/test', async (req, res) => {
  try {
    const products = await tiendanubeRequest('GET', '/products?per_page=1');
    res.json({ ok: true, store_name: 'Tienda conectada OK' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/config/webhook
app.post('/api/config/webhook', async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Falta webhook_url' });

  try {
    await tiendanubeRequest('POST', '/webhooks', {
      event: 'order/paid',
      url: `${webhook_url}/webhook/order`
    });
    await tiendanubeRequest('POST', '/webhooks', {
      event: 'order/cancelled',
      url: `${webhook_url}/webhook/order`
    });

    db.set('config.webhook_registered', true).write();
    res.json({ ok: true, message: 'Webhooks registrados: order/paid y order/cancelled' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── RUTAS: SKUs ─────────────────────────────────────────────────────────────

// GET /api/skus — ahora incluye stock_available (descontando reservas activas)
app.get('/api/skus', (req, res) => {
  const skus = db.get('skus').value();
  const result = skus.map(s => ({
    ...s,
    stock_available: getAvailableStock(s.sku) // ─── NUEVO
  }));
  res.json(result);
});

// GET /api/skus/:sku
app.get('/api/skus/:sku', (req, res) => {
  const skuData = db.get('skus').find({ sku: req.params.sku }).value();
  if (!skuData) return res.status(404).json({ error: 'SKU no encontrado' });
  res.json({
    ...skuData,
    stock_available: getAvailableStock(req.params.sku) // ─── NUEVO
  });
});

// POST /api/skus
app.post('/api/skus', (req, res) => {
  const { sku, stock_central, description } = req.body;
  if (!sku) return res.status(400).json({ error: 'Falta sku' });

  const exists = db.get('skus').find({ sku }).value();
  if (exists) return res.status(409).json({ error: `SKU ${sku} ya existe` });

  const newSku = {
    sku,
    description: description || '',
    stock_central: parseInt(stock_central) || 0,
    variants: [],
    log: [{
      ts: new Date().toISOString(),
      action: 'created',
      stock: parseInt(stock_central) || 0
    }]
  };

  db.get('skus').push(newSku).write();
  res.json(newSku);
});

// PUT /api/skus/:sku/stock
app.put('/api/skus/:sku/stock', async (req, res) => {
  const { sku } = req.params;
  const { delta, absolute, reason, sync } = req.body;

  const skuData = db.get('skus').find({ sku }).value();
  if (!skuData) return res.status(404).json({ error: 'SKU no encontrado' });

  let newStock;
  if (absolute !== undefined) {
    newStock = parseInt(absolute);
  } else if (delta !== undefined) {
    newStock = skuData.stock_central + parseInt(delta);
  } else {
    return res.status(400).json({ error: 'Falta delta o absolute' });
  }

  if (newStock < 0) newStock = 0;

  db.get('skus').find({ sku })
    .assign({ stock_central: newStock })
    .get('log').unshift({
      ts: new Date().toISOString(),
      action: delta < 0 ? 'subtract' : 'add',
      delta: delta || (newStock - skuData.stock_central),
      stock: newStock,
      reason: reason || ''
    }).write();

  let syncResult = null;
  if (sync) {
    try {
      syncResult = await syncSkuToTiendanube(sku);
    } catch (err) {
      syncResult = { ok: false, error: err.message };
    }
  }

  res.json({ ok: true, stock_central: newStock, sync: syncResult });
});

// DELETE /api/skus/:sku
app.delete('/api/skus/:sku', (req, res) => {
  const { sku } = req.params;
  const skuData = db.get('skus').find({ sku }).value();
  if (!skuData) return res.status(404).json({ error: 'SKU no encontrado' });

  // ─── NUEVO: limpiar reservas activas del SKU eliminado
  db.get('reservations').remove({ sku }).write();

  db.get('skus').remove({ sku }).write();
  res.json({ ok: true });
});

// ─── RUTAS: Variantes vinculadas ─────────────────────────────────────────────

// POST /api/skus/:sku/variants
app.post('/api/skus/:sku/variants', (req, res) => {
  const { sku } = req.params;
  const { product_id, variant_id, label } = req.body;
  if (!product_id || !variant_id) return res.status(400).json({ error: 'Falta product_id o variant_id' });

  const skuData = db.get('skus').find({ sku }).value();
  if (!skuData) return res.status(404).json({ error: 'SKU no encontrado' });

  const already = skuData.variants.find(v => v.variant_id == variant_id && v.product_id == product_id);
  if (already) return res.status(409).json({ error: 'Variante ya vinculada' });

  db.get('skus').find({ sku }).get('variants').push({
    product_id: String(product_id),
    variant_id: String(variant_id),
    label: label || `Producto ${product_id} / Variante ${variant_id}`
  }).write();

  res.json({ ok: true });
});

// DELETE /api/skus/:sku/variants/:variant_id
app.delete('/api/skus/:sku/variants/:variant_id', (req, res) => {
  const { sku, variant_id } = req.params;
  db.get('skus').find({ sku }).get('variants').remove({ variant_id }).write();
  res.json({ ok: true });
});

// POST /api/skus/:sku/sync
app.post('/api/skus/:sku/sync', async (req, res) => {
  try {
    const result = await syncSkuToTiendanube(req.params.sku);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products
app.get('/api/products', async (req, res) => {
  try {
    let allProducts = [];
    let page = 1;
    while (true) {
      const batch = await tiendanubeRequest('GET', `/products?per_page=50&page=${page}&fields=id,name,variants`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      allProducts = allProducts.concat(batch);
// Filtrar productos personalizados (se manejan por WhatsApp)
allProducts = allProducts.filter(p => {
  const name = (p.name?.es || p.name || '').toUpperCase();
  return !name.includes('PERSONALIZADO');
});
if (batch.length < 50) break;
      page++;
    }
    res.json(allProducts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NUEVO: RUTAS de Reservas ─────────────────────────────────────────────────

// GET /api/reservations — ver todas las reservas activas (para el panel admin)
app.get('/api/reservations', (req, res) => {
  const now = Date.now();
  const active = db.get('reservations').filter(r => r.expiresAt > now).value();
  res.json(active);
});

// POST /api/reservations — crear reserva cuando cliente agrega al carrito
app.post('/api/reservations', (req, res) => {
  const { sessionId, sku, variantId, qty } = req.body;

  if (!sessionId || !qty) {
    return res.status(400).json({ error: 'Falta sessionId o qty' });
  }

  // Buscar SKU por sku directo o por variantId
  let targetSku = null;
  if (sku) {
    targetSku = db.get('skus').find({ sku }).value();
  } else if (variantId) {
    const allSkus = db.get('skus').value();
    targetSku = allSkus.find(s => s.variants.some(v => v.variant_id === String(variantId)));
  }

  if (!targetSku) {
    // Variante no gestionada por stock central, ignorar silenciosamente
    return res.json({ ok: true, managed: false });
  }

  const available = getAvailableStock(targetSku.sku);

  if (available < qty) {
    return res.status(409).json({
      ok: false,
      error: 'Stock insuficiente',
      available
    });
  }

  // Si ya existe una reserva activa de esta sesión para este SKU, actualizarla
  const now = Date.now();
  const existing = db.get('reservations')
    .find(r => r.sessionId === sessionId && r.sku === targetSku.sku && r.expiresAt > now)
    .value();

  if (existing) {
    // Actualizar cantidad y renovar tiempo
    db.get('reservations')
      .find({ id: existing.id })
      .assign({ qty, expiresAt: now + RESERVATION_DURATION_MS })
      .write();

    console.log(`[RESERVAS] Actualizada: sesión ${sessionId} SKU ${targetSku.sku} qty ${qty}`);
    return res.json({ ok: true, managed: true, reservation_id: existing.id, updated: true });
  }

  // Crear reserva nueva y descontar del stock central
  const reservation = {
    id: uuidv4(),
    sessionId,
    sku: targetSku.sku,
    qty: parseInt(qty),
    expiresAt: now + RESERVATION_DURATION_MS
  };

  const newStock = targetSku.stock_central - parseInt(qty);

  db.get('reservations').push(reservation).write();

  db.get('skus').find({ sku: targetSku.sku })
    .assign({ stock_central: newStock })
    .get('log').unshift({
      ts: new Date().toISOString(),
      action: 'reserved',
      reservation_id: reservation.id,
      session_id: sessionId,
      delta: -parseInt(qty),
      stock: newStock,
      reason: 'Reserva de carrito (30 min)'
    }).write();

  console.log(`[RESERVAS] Nueva: sesión ${sessionId} SKU ${targetSku.sku} qty ${qty} | stock: ${targetSku.stock_central} → ${newStock}`);

  // Sincronizar nuevo stock a Tiendanube
  syncSkuToTiendanube(targetSku.sku).catch(err =>
    console.error(`[RESERVAS] Error sync Tiendanube: ${err.message}`)
  );

  res.json({ ok: true, managed: true, reservation_id: reservation.id });
});

// DELETE /api/reservations/:sessionId — liberar reserva manualmente (cliente vacía carrito)
app.delete('/api/reservations/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { sku } = req.query; // opcional: liberar solo un SKU específico

  const now = Date.now();
  let toRelease;

  if (sku) {
    toRelease = db.get('reservations')
      .filter(r => r.sessionId === sessionId && r.sku === sku && r.expiresAt > now)
      .value();
  } else {
    toRelease = db.get('reservations')
      .filter(r => r.sessionId === sessionId && r.expiresAt > now)
      .value();
  }

  if (toRelease.length === 0) {
    return res.json({ ok: true, released: 0 });
  }

  for (const reservation of toRelease) {
    const skuData = db.get('skus').find({ sku: reservation.sku }).value();
    if (!skuData) continue;

    const newStock = skuData.stock_central + reservation.qty;

    db.get('skus').find({ sku: reservation.sku })
      .assign({ stock_central: newStock })
      .get('log').unshift({
        ts: new Date().toISOString(),
        action: 'reservation_released',
        reservation_id: reservation.id,
        delta: +reservation.qty,
        stock: newStock,
        reason: 'Reserva liberada manualmente'
      }).write();

    syncSkuToTiendanube(reservation.sku).catch(err =>
      console.error(`[RESERVAS] Error sync Tiendanube: ${err.message}`)
    );
  }

  if (sku) {
    db.get('reservations').remove(r => r.sessionId === sessionId && r.sku === sku).write();
  } else {
    db.get('reservations').remove({ sessionId }).write();
  }

  console.log(`[RESERVAS] Liberadas ${toRelease.length} reserva(s) de sesión ${sessionId}`);
  res.json({ ok: true, released: toRelease.length });
});

// ─── WEBHOOK: Órdenes de Tiendanube ─────────────────────────────────────────
app.post('/webhook/order', async (req, res) => {
  res.sendStatus(200);

  const { event, id: order_id, store_id } = req.body;
  console.log(`[WEBHOOK] Evento: ${event} | Orden: ${order_id}`);

  try {
    const fetch = (await import('node-fetch')).default;
    const { access_token } = db.get('config').value();

    const orderRes = await fetch(
      `https://api.tiendanube.com/2025-03/${store_id}/orders/${order_id}`,
      {
        headers: {
          'Authentication': `bearer ${access_token}`,
          'User-Agent': 'StockCentral (soporte@tuapp.com)'
        }
      }
    );
    const order = await orderRes.json();

    for (const product of order.products || []) {
      const { variant_id, quantity, sku: orderSku } = product;

      const allSkus = db.get('skus').value();
      const matchedSku = allSkus.find(s =>
        s.sku === orderSku ||
        s.variants.some(v => v.variant_id === String(variant_id))
      );

      if (!matchedSku) {
        console.log(`[WEBHOOK] Variante ${variant_id} no tiene SKU central vinculado. Ignorado.`);
        continue;
      }

      if (event === 'order/paid') {
        // ─── NUEVO: Buscar y eliminar reserva activa para esta sesión/variante
        // El stock ya fue descontado cuando se creó la reserva, solo hay que limpiarla
        const now = Date.now();
        const activeReservations = db.get('reservations')
          .filter(r => r.sku === matchedSku.sku && r.expiresAt > now)
          .value();

        if (activeReservations.length > 0) {
          // Tomar la reserva más antigua que coincida en cantidad
          const matchingReservation = activeReservations.find(r => r.qty === quantity) || activeReservations[0];

          db.get('reservations').remove({ id: matchingReservation.id }).write();
          console.log(`[WEBHOOK] Reserva ${matchingReservation.id} convertida en venta (orden ${order_id})`);

          // Loguear la venta
          db.get('skus').find({ sku: matchedSku.sku })
            .get('log').unshift({
              ts: new Date().toISOString(),
              action: 'sale',
              order_id: String(order_id),
              reservation_id: matchingReservation.id,
              delta: -quantity,
              stock: matchedSku.stock_central,
              reason: 'Venta confirmada (reserva existente)'
            }).write();

        } else {
          // ─── Sin reserva previa: descontar stock directamente (compra sin pasar por carrito normal)
          const newStock = Math.max(0, matchedSku.stock_central - quantity);
          console.log(`[WEBHOOK] SKU ${matchedSku.sku}: sin reserva previa, descontando directamente ${matchedSku.stock_central} → ${newStock}`);

          db.get('skus').find({ sku: matchedSku.sku })
            .assign({ stock_central: newStock })
            .get('log').unshift({
              ts: new Date().toISOString(),
              action: 'sale',
              order_id: String(order_id),
              delta: -quantity,
              stock: newStock,
              reason: 'Venta sin reserva previa'
            }).write();

          await syncSkuToTiendanube(matchedSku.sku);
        }

      } else if (event === 'order/cancelled') {
        // Devolver stock (igual que antes)
        const newStock = matchedSku.stock_central + quantity;
        console.log(`[WEBHOOK] SKU ${matchedSku.sku}: cancelación, devolviendo ${quantity} unidades → ${newStock}`);

        db.get('skus').find({ sku: matchedSku.sku })
          .assign({ stock_central: newStock })
          .get('log').unshift({
            ts: new Date().toISOString(),
            action: 'return',
            order_id: String(order_id),
            delta: +quantity,
            stock: newStock
          }).write();

        await syncSkuToTiendanube(matchedSku.sku);
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] Error procesando orden:', err.message);
  }
});

// ─── RUTAS: Stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const skus = db.get('skus').value();
  const now = Date.now();
  const activeReservations = db.get('reservations').filter(r => r.expiresAt > now).value(); // ─── NUEVO

  res.json({
    total_skus: skus.length,
    total_variants_linked: skus.reduce((acc, s) => acc + s.variants.length, 0),
    low_stock: skus.filter(s => s.stock_central <= 5 && s.stock_central > 0).length,
    out_of_stock: skus.filter(s => s.stock_central === 0).length,
    active_reservations: activeReservations.length, // ─── NUEVO
    recent_log: skus.flatMap(s => s.log.slice(0, 3).map(l => ({ ...l, sku: s.sku })))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 20)
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('Stock Central corriendo en puerto ' + PORT);
  if (process.env.ACCESS_TOKEN && process.env.STORE_ID) {
    db.set('config.access_token', process.env.ACCESS_TOKEN)
      .set('config.store_id', process.env.STORE_ID)
      .write();
    console.log('Credenciales cargadas: store ' + process.env.STORE_ID);
  }
});
