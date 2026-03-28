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
}).write();

// ─── App Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3001;

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

// POST /api/config/test - testear conexión con Tiendanube
app.post('/api/config/test', async (req, res) => {
  try {
    const products = await tiendanubeRequest('GET', '/products?per_page=1');
    res.json({ ok: true, store_name: 'Tienda conectada OK' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/config/webhook - registrar webhook de órdenes en Tiendanube
app.post('/api/config/webhook', async (req, res) => {
  const { webhook_url } = req.body;
  if (!webhook_url) return res.status(400).json({ error: 'Falta webhook_url' });

  try {
    // Registrar order/paid
    await tiendanubeRequest('POST', '/webhooks', {
      event: 'order/paid',
      url: `${webhook_url}/webhook/order`
    });
    // Registrar order/cancelled (para reponer stock)
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

// GET /api/skus
app.get('/api/skus', (req, res) => {
  res.json(db.get('skus').value());
});

// GET /api/skus/:sku
app.get('/api/skus/:sku', (req, res) => {
  const skuData = db.get('skus').find({ sku: req.params.sku }).value();
  if (!skuData) return res.status(404).json({ error: 'SKU no encontrado' });
  res.json(skuData);
});

// POST /api/skus - crear SKU nuevo
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

// PUT /api/skus/:sku/stock - ajustar stock central
app.put('/api/skus/:sku/stock', async (req, res) => {
  const { sku } = req.params;
  const { delta, absolute, reason, sync } = req.body;
  // delta: sumar/restar (ej: +10, -3) | absolute: valor fijo

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

  // Sincronizar a Tiendanube si se pidió
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

  db.get('skus').remove({ sku }).write();
  res.json({ ok: true });
});

// ─── RUTAS: Variantes vinculadas ─────────────────────────────────────────────

// POST /api/skus/:sku/variants - vincular variante
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

// DELETE /api/skus/:sku/variants/:variant_id - desvincular variante
app.delete('/api/skus/:sku/variants/:variant_id', (req, res) => {
  const { sku, variant_id } = req.params;

  db.get('skus').find({ sku }).get('variants').remove({ variant_id }).write();
  res.json({ ok: true });
});

// POST /api/skus/:sku/sync - forzar sync manual a Tiendanube
app.post('/api/skus/:sku/sync', async (req, res) => {
  try {
    const result = await syncSkuToTiendanube(req.params.sku);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/products - listar productos de Tiendanube para vincular
app.get('/api/products', async (req, res) => {
  try {
    const products = await tiendanubeRequest('GET', '/products?per_page=50&fields=id,name,variants');
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK: Órdenes de Tiendanube ─────────────────────────────────────────
app.post('/webhook/order', async (req, res) => {
  // Responder 200 inmediatamente (Tiendanube espera respuesta en 3 segundos)
  res.sendStatus(200);

  const { event, id: order_id, store_id } = req.body;
  console.log(`[WEBHOOK] Evento: ${event} | Orden: ${order_id}`);

  try {
    const fetch = (await import('node-fetch')).default;
    const { access_token } = db.get('config').value();

    // Obtener detalles de la orden
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

      // Buscar SKU central que tenga esta variante vinculada
      const allSkus = db.get('skus').value();
      const matchedSku = allSkus.find(s =>
        s.sku === orderSku ||
        s.variants.some(v => v.variant_id === String(variant_id))
      );

      if (!matchedSku) {
        console.log(`[WEBHOOK] Variante ${variant_id} no tiene SKU central vinculado. Ignorado.`);
        continue;
      }

      let newStock = matchedSku.stock_central;

      if (event === 'order/paid') {
        newStock = Math.max(0, matchedSku.stock_central - quantity);
        console.log(`[WEBHOOK] SKU ${matchedSku.sku}: ${matchedSku.stock_central} → ${newStock} (vendidos: ${quantity})`);
      } else if (event === 'order/cancelled') {
        newStock = matchedSku.stock_central + quantity;
        console.log(`[WEBHOOK] SKU ${matchedSku.sku}: ${matchedSku.stock_central} → ${newStock} (devueltos: ${quantity})`);
      }

      // Actualizar stock central
      db.get('skus').find({ sku: matchedSku.sku })
        .assign({ stock_central: newStock })
        .get('log').unshift({
          ts: new Date().toISOString(),
          action: event === 'order/paid' ? 'sale' : 'return',
          order_id: String(order_id),
          delta: event === 'order/paid' ? -quantity : +quantity,
          stock: newStock
        }).write();

      // Sincronizar a todas las variantes vinculadas
      await syncSkuToTiendanube(matchedSku.sku);
    }
  } catch (err) {
    console.error('[WEBHOOK] Error procesando orden:', err.message);
  }
});

// ─── RUTAS: Stats ─────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const skus = db.get('skus').value();
  res.json({
    total_skus: skus.length,
    total_variants_linked: skus.reduce((acc, s) => acc + s.variants.length, 0),
    low_stock: skus.filter(s => s.stock_central <= 5 && s.stock_central > 0).length,
    out_of_stock: skus.filter(s => s.stock_central === 0).length,
    recent_log: skus.flatMap(s => s.log.slice(0, 3).map(l => ({ ...l, sku: s.sku })))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts))
      .slice(0, 20)
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Stock Central corriendo en http://localhost:${PORT}`);
  console.log(`📦 Base de datos: ./data/db.json`);
  console.log(`🔗 Webhook endpoint: http://localhost:${PORT}/webhook/order\n`);
});
