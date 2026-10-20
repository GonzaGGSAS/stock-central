/**
 * Stock Central — script del storefront (app de Tiendanube) · v29
 *
 * v28 mandaba diferencias ("agregó 1", "sacó 1") comparando contra el carrito anterior,
 * pero ese estado se perdía al recargar la página. En la página del carrito, sacar un
 * producto recarga la página, así que la reserva nunca se liberaba (quedaba 30 min).
 *
 * v29 manda el carrito COMPLETO a POST /api/reserve/sync cada vez que cambia y cada vez
 * que carga una página. El servidor deja las reservas de la sesión iguales al carrito:
 * agrega lo nuevo, libera lo que se sacó y renueva el tiempo de lo que sigue.
 * No importa si se recarga, se repite o se pierde un aviso.
 */
(function () {
  'use strict';

  var BACKEND = 'https://stock-central-production.up.railway.app';
  var RESERVATION_KEY = 'sc_session_id';
  var POLL_INTERVAL_MS = 2000;
  var VERSION = 'v29';

  function getSessionId() {
    var id = localStorage.getItem(RESERVATION_KEY);
    if (!id) {
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      localStorage.setItem(RESERVATION_KEY, id);
    }
    return id;
  }

  // null = no se sabe cómo está el carrito (LS todavía no cargó): en ese caso NO se manda nada,
  // porque un carrito "vacío" por error liberaría las reservas del cliente.
  function getCartItems() {
    try {
      if (window.LS && window.LS.cart && Array.isArray(window.LS.cart.items)) {
        return window.LS.cart.items;
      }
    } catch (e) {}
    return null;
  }

  // Cantidad por variante (líneas repetidas de la misma variante se suman)
  function cartSnapshot(items) {
    var map = {};
    items.forEach(function (i) {
      var vid = i.variant_id || i.id;
      if (!vid) return;
      map[String(vid)] = (map[String(vid)] || 0) + (parseInt(i.quantity, 10) || 0);
    });
    return map;
  }

  function serialize(map) {
    return Object.keys(map).sort().map(function (k) { return k + ':' + map[k]; }).join('|');
  }

  var lastSent = null;
  var inFlight = false;
  var pending = false;

  function syncCart(force) {
    var items = getCartItems();
    if (items === null) return;
    var map = cartSnapshot(items);
    var state = serialize(map);
    if (!force && state === lastSent) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
    var body = {
      sessionId: getSessionId(),
      items: Object.keys(map).map(function (vid) { return { variant_id: vid, qty: map[vid] }; })
    };
    fetch(BACKEND + '/api/reserve/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    })
      .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
      .then(function (r) {
        if (r.status >= 500 || r.status === 429) return; // se reintenta en el próximo cambio o página
        lastSent = state;
        var d = r.data || {};
        if (d.rejected && d.rejected.length) {
          console.warn('[StockCentral] Sin stock disponible para:', d.rejected);
          try {
            document.dispatchEvent(new CustomEvent('stockcentral:sin-stock', { detail: d.rejected }));
          } catch (e) {}
        }
        if ((d.added && d.added.length) || (d.released && d.released.length)) {
          console.log('[StockCentral] Carrito sincronizado | +', d.added, '| -', d.released);
        }
      })
      .catch(function (err) {
        console.warn('[StockCentral] Error sincronizando carrito:', err.message);
      })
      .then(function () {
        inFlight = false;
        if (pending) { pending = false; syncCart(false); }
      });
  }

  // ── Widget de Matchs (sin cambios respecto de v28) ─────────────────────────
  var matchsCache = null;
  var matchsLoaded = false;

  function loadMatchs(callback) {
    if (matchsLoaded) return callback(matchsCache);
    fetch(BACKEND + '/api/matchs')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        matchsCache = Array.isArray(data) ? data : [];
        matchsLoaded = true;
        console.log('[StockCentral] Matchs cargados:', matchsCache.length);
        callback(matchsCache);
      })
      .catch(function (e) {
        console.warn('[StockCentral] Error cargando matchs:', e.message);
        callback([]);
      });
  }
  window.StockCentralLoadMatchs = loadMatchs;

  function init() {
    console.log('[StockCentral] ' + VERSION + ' inicializado | sesion:', getSessionId());
    var attempts = 0;
    var waitForLS = setInterval(function () {
      attempts++;
      if (getCartItems() !== null) {
        clearInterval(waitForLS);
        // Al cargar cada página se manda el carrito tal cual: libera lo que se sacó
        // (aunque la página se haya recargado) y renueva el tiempo de lo que sigue.
        syncCart(true);
        setInterval(function () { syncCart(false); }, POLL_INTERVAL_MS);
      } else if (attempts > 40) {
        clearInterval(waitForLS);
        console.warn('[StockCentral] LS.cart no disponible en esta página');
      }
    }, 250);

    // Volver a la pestaña o volver atrás en el navegador: re-sincronizar
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') syncCart(true);
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) syncCart(true); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
