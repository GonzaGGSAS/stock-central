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
  reservations: [], // { id, sessionId, productoId, varianteId, qty, expiresAt }
  matchs: []        // { id, nombre, producto1: {tn_product_id, nombre}, producto2: {tn_product_id, nombre} }
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

// ─── Helper: buscar match por tn_variant_id del contenedor ─────────────────
function findMatchByContainerVariant(tn_variant_id) {
  const matchs = db.get('matchs').value();
  for (const m of matchs) {
    if (!m.variantMap) continue;
    const vm = m.variantMap.find(v => v.tn_variant_id === String(tn_variant_id));
    if (vm) return { match: m, vm };
  }
  return null;
}

// ─── Helper: reservar variante individual de producto ────────────────────────
async function reservarVarianteIndividual(sessionId, tn_variant_id, qty, matchReservationId) {
  const productos = db.get('productos').value();
  let foundProd = null, foundVar = null;
  for (const p of productos) {
    for (const v of p.variantes) {
      if (v.links.some(l => l.variant_id === String(tn_variant_id))) { foundProd = p; foundVar = v; break; }
    }
    if (foundProd) break;
  }
  if (!foundProd || !foundVar) {
    console.log(`[MATCH-RESERVA] Variante individual ${tn_variant_id} no en Stock Central, descontando directo en TN`);
    // Descontar directamente en TN si no está en Stock Central
    try {
      const variant = await tnRequest('GET', `/products/${foundProd?.id || 0}/variants/${tn_variant_id}`).catch(() => null);
      if (variant) {
        const newStock = Math.max(0, (variant.stock || 0) - qty);
        await tnRequest('PUT', `/products/${variant.product_id}/variants/${tn_variant_id}`, { stock: newStock });
      }
    } catch(e) { console.warn('[MATCH-RESERVA] Error desconto TN directo:', e.message); }
    return null;
  }

  const now = Date.now();
  const available = getAvailableStock(foundProd.id, foundVar.id);
  if (available < qty) {
    console.warn(`[MATCH-RESERVA] Stock insuficiente para ${foundProd.nombre}/${foundVar.label}: disponible ${available}`);
    return null;
  }

  const reservationId = `res_match_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const newStock = foundVar.stock - parseInt(qty);

  db.get('reservations').push({
    id: reservationId, sessionId,
    productoId: foundProd.id, varianteId: foundVar.id,
    tnVariantId: String(tn_variant_id),
    qty: parseInt(qty), expiresAt: now + RESERVATION_MS,
    matchReservationId: matchReservationId || null // para agrupar reservas del mismo match
  }).write();

  db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
    .assign({ stock: newStock }).get('log').unshift({
      ts: new Date().toISOString(), action: 'reserved',
      reservation_id: reservationId, session_id: sessionId,
      delta: -parseInt(qty), stock: newStock,
      reason: 'Reserva de carrito Match (30 min)'
    }).write();

  syncVariante(foundProd.id, foundVar.id).catch(e => console.error('[MATCH-RESERVA] Sync error:', e.message));
  console.log(`[MATCH-RESERVA] ${foundProd.nombre}/${foundVar.label}: stock ${foundVar.stock} → ${newStock}`);
  return reservationId;
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

// ─── Cron: reconciliar stock cada 6 horas ────────────────────────────────────
setInterval(async () => {
  console.log('[RECONCILIAR] Iniciando chequeo de stock...');
  const productos = db.get('productos').value();
  let corregidos = 0, chequeados = 0, errores = 0;

  for (const prod of productos) {
    for (const variante of prod.variantes) {
      if (!variante.links || variante.links.length === 0) continue;

      // Tomar el primer link como referencia del stock en TN
      const link = variante.links[0];
      try {
        const tnVariant = await tnRequest('GET', `/products/${link.product_id}/variants/${link.variant_id}`);
        chequeados++;
        const tnStock = tnVariant.stock ?? null;

        // Si el stock en TN difiere del de Stock Central, corregir
        if (tnStock !== null && tnStock !== variante.stock) {
          console.log(`[RECONCILIAR] Discrepancia: ${prod.nombre}/${variante.label} | SC: ${variante.stock} | TN: ${tnStock} → corrigiendo SC`);
          db.get('productos').find({ id: prod.id }).get('variantes').find({ id: variante.id })
            .assign({ stock: tnStock }).get('log').unshift({
              ts: new Date().toISOString(), action: 'reconciled',
              delta: tnStock - variante.stock, stock: tnStock,
              reason: `Reconciliación automática (SC: ${variante.stock} → TN: ${tnStock})`
            }).write();
          corregidos++;
        }
      } catch (e) {
        errores++;
        console.warn(`[RECONCILIAR] Error chequeando ${prod.nombre}/${variante.label}:`, e.message);
      }

      // Pequeña pausa para no saturar la API de TN
      await new Promise(r => setTimeout(r, 200));
    }
  }

  console.log(`[RECONCILIAR] Completado: ${chequeados} chequeados, ${corregidos} corregidos, ${errores} errores`);
}, 6 * 60 * 60 * 1000); // cada 6 horas

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

// POST /api/productos/:id/sync-variantes — importar variantes faltantes desde TN
app.post('/api/productos/:id/sync-variantes', async (req, res) => {
  const prod = db.get('productos').find({ id: req.params.id }).value();
  if (!prod) return res.status(404).json({ error: 'Producto no encontrado' });

  try {
    // Buscar el product_id de TN buscando en los links de las variantes existentes
    let tnProductId = null;
    for (const v of prod.variantes) {
      if (v.links && v.links.length > 0) { tnProductId = v.links[0].product_id; break; }
    }
    if (!tnProductId) return res.status(400).json({ error: 'No hay links a TN. Vinculá al menos una variante primero.' });

    // Traer todas las variantes del producto en TN
    const tnProduct = await tnRequest('GET', `/products/${tnProductId}?fields=id,name,variants`);
    const tnVariants = tnProduct.variants || [];

    // Ver qué variant_ids ya están en Stock Central
    const linkedVariantIds = new Set();
    for (const v of prod.variantes) {
      for (const l of v.links) linkedVariantIds.add(l.variant_id);
    }

    // Agregar las que faltan
    const added = [];
    const skipped = [];

    for (const tnV of tnVariants) {
      const tnVId = String(tnV.id);
      if (linkedVariantIds.has(tnVId)) { skipped.push(tnVId); continue; }

      // Construir label de la variante
      const vLabel = tnV.values?.map(vv => Object.values(vv)[0]).join(' / ') || `Variante ${tnV.id}`;
      const pName = typeof tnProduct.name === 'object' ? (tnProduct.name.es || '') : String(tnProduct.name);
      const label = `${pName} · ${vLabel}`;
      const stock = tnV.stock ?? 0;

      // Crear variante en Stock Central
      const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2,4)}`;
      const nueva = {
        id: varId, label: vLabel, stock,
        links: [{ product_id: tnProductId, variant_id: tnVId, label }],
        log: [{ ts: new Date().toISOString(), action: 'created', stock, reason: 'Importada desde TN (sync-variantes)' }]
      };
      db.get('productos').find({ id: req.params.id }).get('variantes').push(nueva).write();
      added.push({ label: vLabel, stock, variant_id: tnVId });
    }

    console.log(`[SYNC-VAR] ${prod.nombre}: +${added.length} variantes importadas, ${skipped.length} ya existían`);
    res.json({ ok: true, added: added.length, skipped: skipped.length, variantes: added });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
    // Verificar si es un variant de un Match contenedor
    const matchResult = findMatchByContainerVariant(variant_id);
    if (matchResult) {
      const { match, vm } = matchResult;
      console.log(`[MATCH-RESERVA] Reservando Match: ${match.nombre} | combo: ${vm.label}`);
      const matchResId = `mres_${Date.now()}`;
      // Reservar ambas variantes individuales
      await Promise.all([
        reservarVarianteIndividual(sessionId, vm.v1id, qty, matchResId),
        reservarVarianteIndividual(sessionId, vm.v2id, qty, matchResId)
      ]);
      return res.json({ ok: true, managed: true, match: match.nombre, combo: vm.label });
    }
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
    // Verificar si es un variant de un Match contenedor
    const matchResult = findMatchByContainerVariant(variant_id);
    if (matchResult) {
      const { match, vm } = matchResult;
      // Liberar reservas de ambas variantes individuales del match
      toRelease = db.get('reservations')
        .filter(r => r.sessionId === sessionId && r.expiresAt > now &&
          (r.tnVariantId === vm.v1id || r.tnVariantId === vm.v2id))
        .value();
    } else {
      // Buscar productoId/varianteId por variant_id de TN normal
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
    }
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
      // IMPORTANTE: releer la DB en cada iteración para evitar race conditions
      // cuando dos items de la misma orden comparten el mismo SKU central
      const productos = db.get('productos').value();
      let foundProd = null, foundVar = null;
      for (const p of productos) {
        for (const v of p.variantes) {
          if (v.links.some(l => l.variant_id === String(variant_id))) {
            foundProd = p;
            // Releer la variante directamente de la DB para tener el stock actualizado
            foundVar = db.get('productos').find({ id: p.id }).get('variantes').find({ id: v.id }).value();
            break;
          }
        }
        if (foundProd) break;
      }
      if (!foundProd || !foundVar) {
        // Verificar si es un producto Match (sc-match)
        const matchFound = db.get('matchs').find(m => 
          m.variantMap && m.variantMap.some(vm => vm.tn_variant_id === String(variant_id))
        ).value();
        
        if (matchFound && event === 'order/paid') {
          const vm = matchFound.variantMap.find(vm => vm.tn_variant_id === String(variant_id));
          console.log(`[WEBHOOK] Match detectado: ${matchFound.nombre} | variante: ${vm.label}`);
          // Descontar stock de producto 1
          await tnRequest('GET', `/products/${matchFound.producto1.tn_product_id}/variants/${vm.v1id}`)
            .then(async v1 => {
              const newStock1 = Math.max(0, (v1.stock || 0) - quantity);
              await tnRequest('PUT', `/products/${matchFound.producto1.tn_product_id}/variants/${vm.v1id}`, { stock: newStock1 });
              console.log(`[WEBHOOK] Match: Prod1 variante ${vm.v1id}: stock → ${newStock1}`);
            }).catch(e => console.error('[WEBHOOK] Error descontando prod1:', e.message));
          // Descontar stock de producto 2
          await tnRequest('GET', `/products/${matchFound.producto2.tn_product_id}/variants/${vm.v2id}`)
            .then(async v2 => {
              const newStock2 = Math.max(0, (v2.stock || 0) - quantity);
              await tnRequest('PUT', `/products/${matchFound.producto2.tn_product_id}/variants/${vm.v2id}`, { stock: newStock2 });
              console.log(`[WEBHOOK] Match: Prod2 variante ${vm.v2id}: stock → ${newStock2}`);
            }).catch(e => console.error('[WEBHOOK] Error descontando prod2:', e.message));
          // Re-sincronizar stock del contenedor
          await fetch(`http://localhost:${process.env.PORT || 3001}/api/matchs/${matchFound.id}/sync-stock`, { method: 'PUT' }).catch(() => {});
        } else {
          console.log(`[WEBHOOK] variant_id ${variant_id} no gestionada. Ignorado.`);
        }
        continue;
      }

      if (event === 'order/paid') {
        // Buscar reserva activa y limpiarla (el stock ya fue descontado al reservar)
        const now = Date.now();
        const activeRes = db.get('reservations')
          .filter(r => r.productoId === foundProd.id && r.varianteId === foundVar.id && r.expiresAt > now)
          .value();

        // Siempre releer el stock actual antes de loguear
        const currentVar = db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id }).value();

        if (activeRes.length > 0) {
          const match = activeRes.find(r => r.qty === quantity) || activeRes[0];
          db.get('reservations').remove({ id: match.id }).write();
          // Stock ya fue descontado al reservar — solo registrar la venta con stock actual
          db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
            .get('log').unshift({
              ts: new Date().toISOString(), action: 'sale',
              order_id: String(order_id), reservation_id: match.id,
              delta: -quantity, stock: currentVar.stock,
              reason: `Venta confirmada — ${item.name || variant_id} (orden #${order_id})`
            }).write();
          console.log(`[WEBHOOK] Reserva ${match.id} convertida en venta (orden ${order_id})`);
        } else {
          // Sin reserva previa: descontar directamente
          const newStock = Math.max(0, currentVar.stock - quantity);
          db.get('productos').find({ id: foundProd.id }).get('variantes').find({ id: foundVar.id })
            .assign({ stock: newStock }).get('log').unshift({
              ts: new Date().toISOString(), action: 'sale',
              order_id: String(order_id), delta: -quantity, stock: newStock,
              reason: `Venta — ${item.name || variant_id} (orden #${order_id})`
            }).write();
          await syncVariante(foundProd.id, foundVar.id);
          console.log(`[WEBHOOK] ${foundProd.nombre}/${foundVar.label}: ${currentVar.stock} → ${newStock}`);
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
// Matchs
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/matchs', (req, res) => {
  res.json(db.get('matchs').value());
});

app.post('/api/matchs', async (req, res) => {
  const { nombre, producto1, producto2 } = req.body;
  if (!nombre || !producto1?.tn_product_id || !producto2?.tn_product_id) {
    return res.status(400).json({ error: 'Faltan datos: nombre, producto1, producto2' });
  }
  try {
    // 1. Obtener variantes de ambos productos
    const [p1data, p2data] = await Promise.all([
      tnRequest('GET', `/products/${producto1.tn_product_id}?fields=id,name,variants`),
      tnRequest('GET', `/products/${producto2.tn_product_id}?fields=id,name,variants`)
    ]);

    const p1name = producto1.nombre || (typeof p1data.name === 'object' ? p1data.name.es : p1data.name) || 'Producto 1';
    const p2name = producto2.nombre || (typeof p2data.name === 'object' ? p2data.name.es : p2data.name) || 'Producto 2';

    const v1list = p1data.variants.filter(v => v.stock === null || v.stock > 0);
    const v2list = p2data.variants.filter(v => v.stock === null || v.stock > 0);

    if (v1list.length === 0 || v2list.length === 0) {
      return res.status(400).json({ error: 'Uno de los productos no tiene variantes con stock' });
    }

    // 2. Generar todas las combinaciones de variantes
    function getLabel(v) {
      if (v.values && v.values.length > 0) {
        const val = v.values[0];
        return val.es || val.en || Object.values(val)[0] || String(v.id);
      }
      return v.sku || String(v.id);
    }

    // 3. Crear producto contenedor en TN
    const attributes = [
      { en: `${p1name} - Talle`, es: `${p1name} - Talle`, pt: `${p1name} - Talle` },
      { en: `${p2name} - Talle`, es: `${p2name} - Talle`, pt: `${p2name} - Talle` }
    ];

    // Construir variantes combinadas
    const variantesBody = [];
    const variantMap = []; // para guardar el mapa v1id+v2id => variant

    for (const v1 of v1list) {
      for (const v2 of v2list) {
        const stock = Math.min(
          v1.stock === null ? 9999 : v1.stock,
          v2.stock === null ? 9999 : v2.stock
        );
        variantesBody.push({
          values: [getLabel(v1), getLabel(v2)],
          price: null, // hereda del producto
          stock: stock === 9999 ? null : stock,
          weight: 1
        });
        variantMap.push({ v1id: String(v1.id), v2id: String(v2.id), label: `${getLabel(v1)} / ${getLabel(v2)}` });
      }
    }

    const productBody = {
      name: { es: nombre, en: nombre, pt: nombre },
      description: { es: '', en: '', pt: '' },
      tags: 'sc-match',
      attributes,
      variants: variantesBody,
      published: true
    };

    const tnProduct = await tnRequest('POST', '/products', productBody);
    const tnMatchProductId = String(tnProduct.id);

    // 4. Guardar match en DB con el mapa de variantes
    const nuevo = {
      id: 'match_' + Date.now(),
      nombre,
      tn_match_product_id: tnMatchProductId,
      producto1: { tn_product_id: String(producto1.tn_product_id), nombre: p1name, variantes: v1list.map(v => ({ id: String(v.id), label: getLabel(v), stock: v.stock })) },
      producto2: { tn_product_id: String(producto2.tn_product_id), nombre: p2name, variantes: v2list.map(v => ({ id: String(v.id), label: getLabel(v), stock: v.stock })) },
      variantMap: variantMap.map((vm, i) => ({ ...vm, tn_variant_id: String(tnProduct.variants[i]?.id || '') })),
      createdAt: new Date().toISOString()
    };
    db.get('matchs').push(nuevo).write();
    console.log(`[MATCH] Creado: ${nombre} | TN product: ${tnMatchProductId} | ${variantesBody.length} variantes`);
    res.json(nuevo);
  } catch (e) {
    console.error('[MATCH] Error creando:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/tn-product/:id/variants — proxy para obtener variantes con stock de un producto TN
app.get('/api/tn-product/:id/variants', async (req, res) => {
  try {
    const product = await tnRequest('GET', `/products/${req.params.id}?fields=id,name,variants`);
    const variants = (product.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || '',
      stock: v.stock ?? null,
      values: v.values || [],
    }));
    res.json({ id: product.id, name: product.name, variants });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/matchs/:id', async (req, res) => {
  const match = db.get('matchs').find({ id: req.params.id }).value();
  if (!match) return res.status(404).json({ error: 'Match no encontrado' });
  const { nombre, precio, precio_promocional, imagen_url } = req.body;
  try {
    // Actualizar en TN
    const tnBody: Record<string, unknown> = {};
    if (nombre) tnBody.name = { es: nombre, en: nombre, pt: nombre };
    if (precio) tnBody.price = precio;
    if (precio_promocional) tnBody.promotional_price = precio_promocional;
    if (imagen_url) tnBody.images = [{ src: imagen_url }];
    if (Object.keys(tnBody).length > 0) {
      await tnRequest('PUT', `/products/${match.tn_match_product_id}`, tnBody);
    }
    // Actualizar en DB local
    const updates: Record<string, unknown> = {};
    if (nombre) updates.nombre = nombre;
    if (precio) updates.precio = precio;
    if (precio_promocional) updates.precio_promocional = precio_promocional;
    if (imagen_url) updates.imagen_url = imagen_url;
    db.get('matchs').find({ id: req.params.id }).assign(updates).write();
    const updated = db.get('matchs').find({ id: req.params.id }).value();
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/matchs/:id', async (req, res) => {
  const match = db.get('matchs').find({ id: req.params.id }).value();
  if (!match) return res.status(404).json({ error: 'Match no encontrado' });
  try {
    // Eliminar producto contenedor de TN
    if (match.tn_match_product_id) {
      await tnRequest('DELETE', `/products/${match.tn_match_product_id}`).catch(e => {
        console.warn('[MATCH] No se pudo eliminar producto TN:', e.message);
      });
    }
  } catch (e) { console.warn('[MATCH] Error eliminando en TN:', e.message); }
  db.get('matchs').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

// PUT /api/matchs/:id/sync-stock — recalcular stock del contenedor basado en productos individuales
app.put('/api/matchs/:id/sync-stock', async (req, res) => {
  const match = db.get('matchs').find({ id: req.params.id }).value();
  if (!match) return res.status(404).json({ error: 'Match no encontrado' });
  try {
    const [p1data, p2data] = await Promise.all([
      tnRequest('GET', `/products/${match.producto1.tn_product_id}?fields=id,variants`),
      tnRequest('GET', `/products/${match.producto2.tn_product_id}?fields=id,variants`)
    ]);
    const p1varMap = Object.fromEntries(p1data.variants.map(v => [String(v.id), v.stock]));
    const p2varMap = Object.fromEntries(p2data.variants.map(v => [String(v.id), v.stock]));
    let updated = 0;
    for (const vm of (match.variantMap || [])) {
      const s1 = p1varMap[vm.v1id] ?? null;
      const s2 = p2varMap[vm.v2id] ?? null;
      const newStock = (s1 === null && s2 === null) ? null : Math.min(s1 === null ? 9999 : s1, s2 === null ? 9999 : s2);
      await tnRequest('PUT', `/products/${match.tn_match_product_id}/variants/${vm.tn_variant_id}`, { stock: newStock });
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
