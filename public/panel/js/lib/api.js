// Cliente HTTP del panel: base URL, token, errores legibles y lectura de streams SSE.

const LS_TOKEN = 'sc_admin_token';
const LS_API = 'sc_api_base';

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* sin storage */ } }

// ?api=https://otro-host guarda el override; ?api= (vacío) o ?api=same lo borra.
function initBase() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('api')) {
      const q = (u.searchParams.get('api') || '').trim();
      if (!q || q === 'same') lsSet(LS_API, null);
      else if (/^https?:\/\//i.test(q)) lsSet(LS_API, q.replace(/\/+$/, ''));
      u.searchParams.delete('api');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch { /* URL inválida: seguimos con lo guardado */ }
  return (lsGet(LS_API) || '').replace(/\/+$/, '');
}

export const API_BASE = initBase();
export const API_ORIGIN = API_BASE || location.origin;

export const getToken = () => lsGet(LS_TOKEN) || '';
export const setToken = (t) => lsSet(LS_TOKEN, t ? String(t).trim() : null);

// ─── Bus de eventos del cliente (auth, red, requests en vuelo) ───────────────
const listeners = {};
export function onApi(type, fn) {
  (listeners[type] ||= new Set()).add(fn);
  return () => listeners[type].delete(fn);
}
function emit(type, payload) { (listeners[type] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); }

let inflight = 0;
function busy(d) { inflight += d; emit('busy', inflight); }

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = null, path = '', network = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status; this.code = code; this.details = details; this.path = path; this.network = network;
  }
}

function headers(extra = {}, json = false) {
  const h = { Accept: 'application/json', ...extra };
  if (json) h['Content-Type'] = 'application/json';
  const t = getToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}

function errorFrom(res, data, method, path) {
  const clean = path.split('?')[0];
  let msg = data && typeof data === 'object' && (data.error || data.message);
  if (!msg) {
    if (res.status === 404) msg = `Esta función todavía no está disponible en el servidor (${method} ${clean} → 404).`;
    else if (res.status === 502 || res.status === 503 || res.status === 504) msg = `El servidor no está respondiendo (${res.status}). Probá de nuevo en un rato.`;
    else msg = `El servidor respondió con un error ${res.status} en ${method} ${clean}.`;
  }
  return new ApiError(String(msg), { status: res.status, code: data?.code || '', details: data?.details ?? null, path: clean });
}

/**
 * api('/api/overview') · api('/api/x', { method: 'POST', body: {...} })
 * Tira ApiError con el mensaje del backend (`error` del JSON) o uno claro si no vino.
 */
export async function api(path, { method = 'GET', body, signal, timeout = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = timeout ? setTimeout(() => ctrl.abort('timeout'), timeout) : null;
  const onAbort = () => ctrl.abort('cancel');
  if (signal) { if (signal.aborted) ctrl.abort('cancel'); else signal.addEventListener('abort', onAbort, { once: true }); }
  busy(+1);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: headers({}, body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason === 'timeout') {
      throw new ApiError(`El servidor tardó demasiado en responder (${Math.round(timeout / 1000)} s).`, { path, network: false, code: 'timeout' });
    }
    if (ctrl.signal.aborted) { const err = new Error('cancelado'); err.name = 'AbortError'; throw err; }
    emit('net', false);
    throw new ApiError('Sin conexión con el servidor.', { path, network: true, code: 'network' });
  } finally {
    busy(-1);
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  emit('net', true);
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (res.status === 401) {
    emit('auth', data);
    throw new ApiError(data?.error || 'No autorizado. Ingresá el token de administrador.', { status: 401, code: 'unauthorized', path });
  }
  if (!res.ok) throw errorFrom(res, data, method, path);
  if (text && data === null) {
    throw new ApiError(`Respuesta inesperada del servidor en ${path.split('?')[0]} (no es JSON).`, { status: res.status, path });
  }
  return data;
}

/**
 * POST que responde Server-Sent Events (sync con progreso).
 * Llama onEvent({type:'progress'|'done'|'error', ...}). Si el server devuelve JSON, lo convierte en 'done'.
 */
export async function apiStream(path, { method = 'POST', body, onEvent, signal } = {}) {
  busy(+1);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { ...headers({}, body !== undefined), Accept: 'text/event-stream' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    busy(-1);
    if (signal?.aborted) throw e;
    emit('net', false);
    throw new ApiError('Sin conexión con el servidor.', { path, network: true, code: 'network' });
  }
  emit('net', true);
  try {
    if (res.status === 401) { emit('auth'); throw new ApiError('No autorizado. Ingresá el token de administrador.', { status: 401, code: 'unauthorized', path }); }
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('text/event-stream')) {
      const text = await res.text().catch(() => '');
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* */ }
      if (!res.ok) throw errorFrom(res, data, method, path);
      const ev = { type: data && data.ok === false ? 'error' : 'done', ...(data || {}) };
      onEvent?.(ev);
      return ev;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', last = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const dataLines = chunk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        try { last = JSON.parse(dataLines.join('\n')); onEvent?.(last); } catch { /* línea no JSON */ }
      }
    }
    if (!last || (last.type !== 'done' && last.type !== 'error')) {
      throw new ApiError('La conexión se cortó antes de terminar la sincronización.', { path, code: 'stream_cut' });
    }
    return last;
  } finally { busy(-1); }
}

/** URL del stream de eventos en vivo (EventSource no manda headers: token por query). */
export function eventsUrl() {
  const t = getToken();
  return API_BASE + '/api/events' + (t ? '?token=' + encodeURIComponent(t) : '');
}

/** Ping liviano: true si el servidor contesta algo (aunque sea 404). */
export async function ping() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(API_BASE + '/api/health', { cache: 'no-store', signal: ctrl.signal, headers: headers() });
    clearTimeout(t);
    return res.status > 0;
  } catch { return false; }
}
