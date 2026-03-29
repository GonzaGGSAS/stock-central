(function () {
  'use strict';

  var BACKEND = 'https://stock-central-production.up.railway.app';
  var RESERVATION_KEY = 'sc_session_id';

  // ── Generar o recuperar sessionId persistente ──────────────────────────────
  function getSessionId() {
    var id = localStorage.getItem(RESERVATION_KEY);
    if (!id) {
      // Generar UUID v4 compatible con navegadores viejos
      id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      localStorage.setItem(RESERVATION_KEY, id);
    }
    return id;
  }

  // ── Llamar al backend para reservar stock ──────────────────────────────────
  function reserveStock(variantId, qty) {
    var sessionId = getSessionId();
    fetch(BACKEND + '/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId,
        variantId: String(variantId),
        qty: parseInt(qty) || 1
      })
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.managed) {
        console.log('[StockCentral] Reserva OK - variantId:', variantId, '| qty:', qty);
      }
    })
    .catch(function (err) {
      console.warn('[StockCentral] Error al reservar:', err.message);
    });
  }

  // ── Llamar al backend para liberar stock ───────────────────────────────────
  function releaseStock(variantId) {
    var sessionId = getSessionId();
    fetch(BACKEND + '/api/reservations/' + sessionId + (variantId ? '?sku=' + variantId : ''), {
      method: 'DELETE'
    }).catch(function (err) {
      console.warn('[StockCentral] Error al liberar:', err.message);
    });
  }

  // ── Estrategia 1: API nativa de Tiendanube (LS object) ────────────────────
  // El tema Amazonas expone window.LS con eventos del carrito
  function hookTiendanubeLS() {
    if (typeof window.LS === 'undefined') return false;

    // Interceptar LS.cart.add si existe
    if (window.LS.cart && typeof window.LS.cart.add === 'function') {
      var originalAdd = window.LS.cart.add.bind(window.LS.cart);
      window.LS.cart.add = function (variantId, qty, callback) {
        reserveStock(variantId, qty || 1);
        return originalAdd(variantId, qty, callback);
      };
      console.log('[StockCentral] Hook en LS.cart.add OK');
      return true;
    }
    return false;
  }

  // ── Estrategia 2: Evento nativo del DOM que dispara Tiendanube ────────────
  // Tiendanube dispara 'cart:add' o 'cart:item:added' en document
  function hookCartEvents() {
    var events = ['cart:add', 'cart:item:added', 'cartadd', 'addtocart'];
    events.forEach(function (eventName) {
      document.addEventListener(eventName, function (e) {
        var detail = e.detail || {};
        var variantId = detail.variant_id || detail.variantId || detail.id;
        var qty = detail.quantity || detail.qty || 1;
        if (variantId) {
          console.log('[StockCentral] Evento DOM:', eventName, variantId, qty);
          reserveStock(variantId, qty);
        }
      });
    });
  }

  // ── Estrategia 3: Interceptar fetch/XHR al endpoint de carrito ────────────
  // Tiendanube usa fetch interno para agregar al carrito
  function hookFetch() {
    var originalFetch = window.fetch;
    window.fetch = function (url, options) {
      var urlStr = typeof url === 'string' ? url : (url && url.url) || '';

      // Detectar llamadas al endpoint de carrito de Tiendanube
      if (urlStr.indexOf('/cart/add') !== -1 || urlStr.indexOf('cart/items') !== -1) {
        try {
          var body = options && options.body;
          if (body) {
            var data = typeof body === 'string' ? JSON.parse(body) : body;
            var variantId = data.variant_id || data.variantId || data.id;
            var qty = data.quantity || data.qty || 1;
            if (variantId) {
              console.log('[StockCentral] Fetch interceptado - carrito:', variantId, qty);
              reserveStock(variantId, qty);
            }
          }
        } catch (e) {
          // Ignorar errores de parseo
        }
      }

      return originalFetch.apply(this, arguments);
    };
  }

  // ── Estrategia 4: Interceptar XMLHttpRequest ───────────────────────────────
  function hookXHR() {
    var OriginalXHR = window.XMLHttpRequest;
    function PatchedXHR() {
      var xhr = new OriginalXHR();
      var _send = xhr.send.bind(xhr);
      var _open = xhr.open.bind(xhr);
      var _url = '';

      xhr.open = function (method, url) {
        _url = url || '';
        return _open.apply(xhr, arguments);
      };

      xhr.send = function (body) {
        if (_url.indexOf('/cart/add') !== -1 || _url.indexOf('cart/items') !== -1) {
          try {
            var data = typeof body === 'string' ? JSON.parse(body) : body;
            var variantId = data && (data.variant_id || data.id);
            var qty = data && (data.quantity || 1);
            if (variantId) {
              console.log('[StockCentral] XHR interceptado - carrito:', variantId, qty);
              reserveStock(variantId, qty);
            }
          } catch (e) { /* ignorar */ }
        }
        return _send.apply(xhr, arguments);
      };

      return xhr;
    }
    window.XMLHttpRequest = PatchedXHR;
  }

  // ── Escuchar vaciado de carrito ────────────────────────────────────────────
  function hookCartClear() {
    var events = ['cart:clear', 'cart:empty', 'cart:removed'];
    events.forEach(function (eventName) {
      document.addEventListener(eventName, function () {
        console.log('[StockCentral] Carrito vaciado, liberando reservas...');
        releaseStock(null);
      });
    });
  }

  // ── Inicializar ───────────────────────────────────────────────────────────
  function init() {
    // Intentar hook nativo primero
    var lsHooked = hookTiendanubeLS();

    // Siempre activar el resto como respaldo
    hookCartEvents();
    hookFetch();
    hookXHR();
    hookCartClear();

    console.log('[StockCentral] Storefront script inicializado | sesión:', getSessionId());

    // Reintentar LS hook si no estaba listo todavía
    if (!lsHooked) {
      setTimeout(function () {
        hookTiendanubeLS();
      }, 2000);
    }
  }

  // Esperar a que el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
