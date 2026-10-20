// Tareas largas (POST /api/jobs) con progreso real consultando GET /api/jobs/:id.
// Viven fuera de las vistas: se puede navegar mientras corren.
import { api } from './api.js';
import { createStore, invalidate } from './store.js';
import { toast } from '../ui/overlay.js';

export const JOB_TYPES = {
  'resync-matchs': { label: 'Actualizar stock de combos', desc: 'Recalcula el stock de cada combinación de todos los combos y lo sube a Tiendanube.' },
  'repair-matchs': { label: 'Agregar talles faltantes a combos', desc: 'Agrega a los combos los talles nuevos que se sumaron a sus productos en Tiendanube.' },
  'reconcile': { label: 'Revisar órdenes y stock contra Tiendanube', desc: 'Busca órdenes que no llegaron por webhook y compara el stock de Tiendanube con el de Stock Central; corrige las diferencias.' },
  'sync-all': { label: 'Sincronizar todo el stock a Tiendanube', desc: 'Sube el stock de todas las variantes a todos sus productos vinculados en Tiendanube. Tarda varios minutos.' },
  'sync-product': { label: 'Sincronizar producto', desc: 'Sube el stock de todas las variantes de un producto.' },
};

/** id → job */
export const jobsStore = createStore({});
const pollers = new Map();
const watched = new Set(); // jobs que vimos corriendo en esta sesión (para avisar al terminar)

function upsert(job) {
  if (!job || !job.id) return;
  jobsStore.set(s => ({ ...s, [job.id]: { ...(s[job.id] || {}), ...job, label: job.label || JOB_TYPES[job.type]?.label || s[job.id]?.label || job.type } }));
}

function finished(job) {
  stopPoll(job.id);
  if (!watched.has(job.id)) return;
  watched.delete(job.id);
  const name = job.label || JOB_TYPES[job.type]?.label || 'Tarea';
  const errs = Array.isArray(job.errors) ? job.errors.length : 0;
  if (job.status === 'error') toast(`${name}: falló — ${job.error || 'error desconocido'}`, { tone: 'bad' });
  else if (errs) toast(`${name}: terminó con ${errs} error${errs === 1 ? '' : 'es'}`, { tone: 'warn', timeout: 7000 });
  else toast(`${name}: listo`);
  ['matchs', 'productos', 'overview', 'activity', 'alerts', 'jobs'].forEach(k => invalidate(k));
}

function stopPoll(id) { clearTimeout(pollers.get(id)); pollers.delete(id); }

async function poll(id, failures = 0) {
  stopPoll(id);
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`, { timeout: 15000 });
    upsert(job);
    if (job.status === 'running') schedule(id, 0);
    else finished(job);
  } catch (e) {
    if (e.status === 404 && !e.message.includes('todavía')) {
      upsert({ id, status: 'error', error: 'La tarea ya no existe en el servidor (¿se reinició?).' });
      finished({ ...jobsStore.get()[id], status: 'error', error: 'La tarea ya no existe en el servidor.' });
      return;
    }
    if (e.status === 401) return;
    upsert({ id, poll_error: e.message });
    if (failures >= 12) {
      upsert({ id, status: 'error', error: `No se pudo consultar el progreso: ${e.message}` });
      finished({ ...jobsStore.get()[id] });
      return;
    }
    schedule(id, failures + 1);
  }
}
function schedule(id, failures) {
  const ms = Math.min(15000, 1200 * Math.pow(1.6, failures));
  pollers.set(id, setTimeout(() => poll(id, failures), ms));
}

export function trackJob(job) {
  upsert(job);
  if (job.status === 'running') {
    watched.add(job.id);
    if (!pollers.has(job.id)) schedule(job.id, 0);
  }
}

/** Mezcla jobs que vienen de /api/overview o /api/jobs. */
export function ingestJobs(list) {
  if (!Array.isArray(list)) return;
  for (const j of list) {
    const known = jobsStore.get()[j.id];
    if (j.status === 'running') trackJob(j);
    else if (known?.status === 'running') { upsert(j); finished({ ...known, ...j }); }
    else upsert(j);
  }
}

/** Evento SSE de jobs: consultamos ya, sin esperar el próximo poll. */
export function pokeJob(id) {
  if (id && pollers.has(id)) poll(id);
}

export async function startJob(type, extra = {}) {
  const r = await api('/api/jobs', { method: 'POST', body: { type, ...extra } });
  const job = {
    type, label: JOB_TYPES[type]?.label || type, status: 'running', progress: { current: 0, total: 0, message: 'Arrancando…' },
    started_at: new Date().toISOString(), finished_at: null, errors: [], ...r,
  };
  if (!job.id) throw new Error('El servidor no devolvió el id de la tarea.');
  trackJob(job);
  return job;
}

export const runningJobs = (s) => Object.values(s).filter(j => j.status === 'running');
