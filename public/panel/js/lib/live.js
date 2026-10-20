// Tiempo real: EventSource a /api/events; si falla, polling cada 20 s.
import { eventsUrl } from './api.js';
import { createStore } from './store.js';

// mode: 'connecting' | 'live' | 'polling'
export const liveStatus = createStore({ mode: 'connecting', since: Date.now() });

const POLL_MS = 20000;
const SSE_RETRY_MS = 60000;
let es = null, pollTimer = null, retryTimer = null, handler = () => {}, errors = 0;

function setMode(mode) {
  if (liveStatus.get().mode !== mode) liveStatus.set({ mode, since: Date.now() });
}

function startPolling() {
  setMode('polling');
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') handler({ topic: '*' });
  }, POLL_MS);
  // Reintenta SSE cada tanto por si el backend ya lo tiene.
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, SSE_RETRY_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; clearTimeout(retryTimer); }

function connect() {
  if (typeof EventSource === 'undefined') { startPolling(); return; }
  try { es?.close(); } catch { /* */ }
  let opened = false;
  es = new EventSource(eventsUrl());
  es.addEventListener('open', () => {
    opened = true; errors = 0;
    const wasPolling = !!pollTimer;
    stopPolling();
    setMode('live');
    // Al reconectar puede haberse perdido algo: refrescamos lo que está en pantalla.
    if (wasPolling) handler({ topic: '*' });
  });
  const onChange = (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data && data.topic) handler(data);
  };
  es.addEventListener('change', onChange);
  es.addEventListener('message', onChange);
  es.addEventListener('error', () => {
    errors++;
    // CLOSED = el server respondió algo que no es un stream (404, 401…): no hay SSE, vamos a polling.
    if (es.readyState === EventSource.CLOSED || !opened || errors > 2) {
      try { es.close(); } catch { /* */ }
      es = null;
      startPolling();
    } else {
      setMode('connecting');
    }
  });
}

/** onChange recibe {topic, productoId?, jobId?}; topic '*' = refrescar todo lo visible. */
export function startLive(onChange) {
  handler = onChange;
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && liveStatus.get().mode === 'polling') handler({ topic: '*' });
  });
}

/** Reconectar (ej. después de cambiar el token). */
export function restartLive() { stopPolling(); connect(); }
