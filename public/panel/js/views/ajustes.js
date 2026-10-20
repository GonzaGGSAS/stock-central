// Ajustes: credenciales de TN, webhooks, mantenimiento (tareas largas) y datos del panel.
import { html, useState, useEffect } from '../../vendor/htm-preact-3.1.1.js';
import { api, API_BASE, API_ORIGIN, getToken, setToken } from '../lib/api.js';
import { useResource, useStore, invalidate } from '../lib/store.js';
import { fmtDate, fmtNum } from '../lib/format.js';
import { JOB_TYPES, jobsStore, startJob, ingestJobs } from '../lib/jobs.js';
import { restartLive } from '../lib/live.js';
import { Button, ErrorBox, Skeleton, Field, Progress, Pill, Refreshing, useAction, cx } from '../ui/components.js';
import { Icon } from '../ui/icons.js';
import { toast, confirmDialog } from '../ui/overlay.js';

function Credentials() {
  const r = useResource('config', (signal) => api('/api/config', { signal }));
  const [storeId, setStoreId] = useState('');
  const [token, setTok] = useState('');
  useEffect(() => { if (r.data?.store_id && !storeId) setStoreId(String(r.data.store_id)); }, [r.data]);
  const [save, saveSt] = useAction(async () => {
    await api('/api/config', { method: 'POST', body: { store_id: storeId.trim(), access_token: token.trim() } });
    setTok('');
    invalidate('config', { delay: 0 }); invalidate('overview'); invalidate('tn-products');
    toast('Credenciales guardadas');
    return true;
  });
  const [test, testSt] = useAction(() => api('/api/config/test', { method: 'POST', timeout: 30000 }));
  const submit = (e) => { e.preventDefault(); if (storeId.trim() && token.trim()) save(); };
  return html`<section class="card" aria-labelledby="cred-h">
    <div class="sec-head"><h2 id="cred-h">Conexión con Tiendanube</h2><${Refreshing} on=${r.refreshing} /></div>
    ${r.loading ? html`<${Skeleton} h=${80} />` : null}
    <${ErrorBox} error=${r.error && !r.data ? r.error : null} title="No se pudo leer la configuración" onRetry=${r.reload} />
    ${r.data ? html`<ul class="health">
      <li><span class=${'dot ' + (r.data.has_token ? 'dot-ok' : 'dot-bad')}></span>${r.data.has_token ? `Token guardado · tienda ${r.data.store_id || '—'}` : 'Sin token: Tiendanube no está conectado'}</li>
      <li><span class=${'dot ' + (r.data.webhook_registered ? 'dot-ok' : 'dot-warn')}></span>${r.data.webhook_registered ? 'Webhooks registrados' : 'Webhooks sin registrar'}</li>
    </ul>` : null}
    <form class="form-grid" onSubmit=${submit}>
      <div class="form-2">
        <${Field} label="Store ID"><input type="text" inputmode="numeric" autocomplete="off" value=${storeId} onInput=${(e) => setStoreId(e.currentTarget.value)} placeholder="1443972" /></${Field}>
        <${Field} label="Access token" hint=${r.data?.has_token ? 'Ya hay uno guardado. Pegá uno nuevo solo si querés cambiarlo.' : 'Lo sacás de la app en partners.tiendanube.com.'}>
          <input type="password" autocomplete="off" value=${token} onInput=${(e) => setTok(e.currentTarget.value)} placeholder=${r.data?.has_token ? '•••••••• (guardado)' : 'Pegá el token'} /></${Field}>
      </div>
      <div class="row-gap">
        <${Button} type="submit" kind="primary" loading=${saveSt.loading} disabled=${!storeId.trim() || !token.trim()}>Guardar</${Button}>
        <${Button} icon="play" loading=${testSt.loading} busyText="Probando…" onClick=${() => test()}>Probar conexión</${Button}>
        ${testSt.data && !testSt.error ? html`<span class="tone-ok small" role="status"><${Icon} name="check" size=${14} /> ${testSt.data.store_name || 'Conectado'}</span>` : null}
      </div>
    </form>
    <${ErrorBox} compact error=${saveSt.error} title="No se guardó" onRetry=${() => save()} />
    <${ErrorBox} compact error=${testSt.error} title="La conexión falló" onRetry=${() => test()} />
  </section>`;
}

function Webhooks() {
  const [url, setUrl] = useState(API_ORIGIN);
  const [list, listSt] = useAction(() => api('/api/admin/webhooks', { timeout: 30000 }));
  const [reg, regSt] = useAction(async () => {
    const r = await api('/api/admin/webhooks/clean-and-register', { method: 'POST', body: { webhook_url: url.trim().replace(/\/+$/, '') }, timeout: 90000 });
    const fails = (r?.registered || []).filter(x => x.error);
    if (fails.length) toast(`Webhooks: ${fails.length} no se pudieron registrar`, { tone: 'warn' });
    else toast('Webhooks registrados');
    invalidate('config'); invalidate('overview');
    list();
    return r;
  });
  const ask = async () => {
    const ok = await confirmDialog({ title: '¿Limpiar y registrar webhooks?', body: `Se borran todos los webhooks de la tienda y se registran order/created, order/paid y order/cancelled apuntando a ${url.trim()}/webhook/order.`, confirm: 'Limpiar y registrar' });
    if (ok) reg();
  };
  const expected = url.trim().replace(/\/+$/, '') + '/webhook/order';
  const hooks = Array.isArray(listSt.data) ? listSt.data : null;
  const events = hooks ? hooks.reduce((a, h) => { a[h.event] = (a[h.event] || 0) + 1; return a; }, {}) : {};
  return html`<section class="card" aria-labelledby="wh-h">
    <div class="sec-head"><h2 id="wh-h">Webhooks</h2></div>
    <p class="muted small">Son los avisos que manda Tiendanube cuando entra, se paga o se cancela una orden. Sin ellos las ventas no descuentan stock.</p>
    <div class="row-gap">
      <${Button} icon="refresh" loading=${listSt.loading} busyText="Consultando TN…" onClick=${() => list()}>${hooks ? 'Actualizar lista' : 'Ver webhooks'}</${Button}>
    </div>
    <${ErrorBox} compact error=${listSt.error} title="No se pudo listar" onRetry=${() => list()} />
    ${hooks ? (hooks.length ? html`<ul class="wh-list">
      ${hooks.map(h => {
        const ok = h.url === expected;
        const dup = events[h.event] > 1;
        return html`<li key=${h.id}>
          <span class=${'dot ' + (ok && !dup ? 'dot-ok' : 'dot-warn')}></span>
          <strong>${h.event}</strong>
          <span class="muted small wh-url">${h.url}</span>
          ${!ok ? html`<${Pill} tone="warn">otra URL</${Pill}>` : null}${dup ? html`<${Pill} tone="warn">duplicado</${Pill}>` : null}
        </li>`;
      })}</ul>` : html`<p class="tone-bad small">No hay webhooks registrados en la tienda.</p>`) : null}
    <form class="form-grid" onSubmit=${(e) => { e.preventDefault(); ask(); }}>
      <${Field} label="URL pública del servidor" hint=${`Se registra ${expected}`}>
        <input type="url" value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} required /></${Field}>
      <div><${Button} type="submit" loading=${regSt.loading} busyText="Registrando…">Limpiar y registrar</${Button}></div>
    </form>
    <${ErrorBox} compact error=${regSt.error} title="No se pudieron registrar" onRetry=${() => reg()} />
    ${regSt.data ? html`<p class="small muted" role="status">Borrados: ${regSt.data.deleted?.length ?? 0} · Registrados: ${(regSt.data.registered || []).filter(x => !x.error).length} de ${(regSt.data.registered || []).length}
      ${(regSt.data.registered || []).filter(x => x.error).map(x => html`<span class="tone-bad"> · ${x.event}: ${x.error}</span>`)}</p>` : null}
  </section>`;
}

function JobCard({ type, last }) {
  const t = JOB_TYPES[type];
  const [run, st] = useAction(() => startJob(type));
  const running = last?.status === 'running';
  const errs = Array.isArray(last?.errors) ? last.errors : [];
  const p = last?.progress || {};
  return html`<li class="job">
    <div class="job-main">
      <strong>${t.label}</strong>
      <span class="muted small">${t.desc}</span>
    </div>
    <${Button} icon="play" loading=${st.loading || running} busyText=${running ? 'En curso' : 'Iniciando…'} onClick=${() => run()}>Ejecutar</${Button}>
    ${running ? html`<div class="job-prog">
      <${Progress} current=${p.current} total=${p.total} label=${t.label} />
      <span class="muted small">${p.total ? `${fmtNum(p.current)} de ${fmtNum(p.total)}` : 'Arrancando…'}${p.message ? ` · ${p.message}` : ''}</span>
      ${last.poll_error ? html`<span class="tone-warn small">Sin respuesta del progreso (${last.poll_error}). Reintentando…</span>` : null}
    </div>` : null}
    ${last && !running ? html`<div class="job-prog">
      <span class=${cx('small', last.status === 'error' ? 'tone-bad' : errs.length ? 'tone-warn' : 'tone-ok')}>
        ${last.status === 'error' ? `Falló ${fmtDate(last.finished_at || last.started_at)}: ${last.error || 'error'}`
          : `Última vez ${fmtDate(last.finished_at || last.started_at)}${errs.length ? ` · ${errs.length} con error` : ' · sin errores'}`}
      </span>
      ${errs.length ? html`<details class="small"><summary>Ver errores</summary><ul class="sync-errs">
        ${errs.slice(0, 50).map((e, i) => html`<li key=${i}><${Icon} name="alert" size=${14} /><span>${typeof e === 'string' ? e : `${e.label || e.nombre || e.id || ''}${e.label || e.nombre || e.id ? ': ' : ''}${e.error || JSON.stringify(e)}`}</span></li>`)}
      </ul></details>` : null}
    </div>` : null}
    <${ErrorBox} compact error=${st.error} title="No se pudo iniciar" onRetry=${() => run()} onClose=${st.reset} />
  </li>`;
}

function Maintenance() {
  const r = useResource('jobs', (signal) => api('/api/jobs', { signal }));
  useEffect(() => { if (Array.isArray(r.data)) ingestJobs(r.data); }, [r.data]);
  const jobs = useStore(jobsStore);
  const lastOf = (type) => Object.values(jobs).filter(j => j.type === type)
    .sort((a, b) => (b.status === 'running') - (a.status === 'running') || String(b.started_at || '').localeCompare(String(a.started_at || '')))[0];
  return html`<section class="card" aria-labelledby="mt-h">
    <div class="sec-head"><h2 id="mt-h">Mantenimiento</h2><${Refreshing} on=${r.refreshing} /></div>
    <p class="muted small">Tareas largas. Corren en el servidor: podés seguir usando el panel mientras tanto.</p>
    <${ErrorBox} compact error=${r.error && !r.data ? r.error : null} title="No se pudo leer el historial de tareas" onRetry=${r.reload} />
    <ul class="jobs">${['resync-matchs', 'repair-matchs', 'reconcile', 'sync-all'].map(t => html`<${JobCard} key=${t} type=${t} last=${lastOf(t)} />`)}</ul>
  </section>`;
}

// Copias de seguridad: una por día en el servidor; acá se ve la última y se baja una copia
function Backups() {
  const r = useResource('backups', (signal) => api('/api/admin/backups', { signal }));
  const [make, makeSt] = useAction(async () => {
    const x = await api('/api/admin/backups', { method: 'POST', timeout: 60000 });
    invalidate('backups', { delay: 0 });
    toast(`Copia hecha (${fmtKb(x.size)})`);
    return x;
  });
  const [download, dlSt] = useAction(async () => {
    const data = await api('/api/admin/backup', { timeout: 60000 });
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `stock-central-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Copia descargada');
    return true;
  });
  const list = r.data?.backups || [];
  const last = r.data?.last_backup_at ? Date.parse(r.data.last_backup_at) : null;
  const stale = last != null && Date.now() - last > 36 * 3600e3;
  return html`<section class="card" aria-labelledby="bk-h">
    <div class="sec-head"><h2 id="bk-h">Copias de seguridad</h2><${Refreshing} on=${r.refreshing} /></div>
    <p class="muted small">El servidor guarda una copia de toda la base por día (las últimas ${r.data?.keep || 14}). Descargá una de vez en cuando y guardala en tu compu o en Drive.</p>
    ${r.loading ? html`<${Skeleton} h=${48} />` : null}
    <${ErrorBox} compact error=${r.error && !r.data ? r.error : null} title="No se pudo leer la lista de copias" onRetry=${r.reload} />
    ${r.data ? html`<dl class="kv">
      <dt>Última copia</dt>
      <dd>${last ? html`<${Pill} tone=${stale ? 'warn' : 'ok'}>${fmtDate(r.data.last_backup_at)}</${Pill}>${stale ? html` <span class="small muted">hace más de un día</span>` : null}` : html`<${Pill} tone="warn">Todavía ninguna</${Pill}>`}</dd>
      <dt>Guardadas</dt><dd>${list.length} ${list.length === 1 ? 'copia' : 'copias'}${list[0] ? html` · la última pesa ${fmtKb(list[0].size)}` : null}</dd>
    </dl>` : null}
    <div class="row-gap">
      <${Button} icon="download" loading=${dlSt.loading} busyText="Descargando…" onClick=${() => download()}>Descargar copia</${Button}>
      <${Button} kind="ghost" icon="refresh" loading=${makeSt.loading} busyText="Copiando…" onClick=${() => make()}>Hacer copia ahora</${Button}>
    </div>
    <${ErrorBox} compact error=${dlSt.error} title="No se pudo descargar" onRetry=${() => download()} onClose=${dlSt.reset} />
    <${ErrorBox} compact error=${makeSt.error} title="No se pudo hacer la copia" onRetry=${() => make()} onClose=${makeSt.reset} />
  </section>`;
}
function fmtKb(b) { return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }

function PanelInfo() {
  const r = useResource('health', (signal) => api('/api/health', { signal }));
  const hasTok = !!getToken();
  const logout = () => { setToken(null); restartLive(); invalidate('*', { delay: 0 }); toast('Sesión cerrada en este navegador'); };
  return html`<section class="card" aria-labelledby="pn-h">
    <div class="sec-head"><h2 id="pn-h">Panel</h2></div>
    <dl class="kv">
      <dt>Servidor</dt><dd>${API_BASE || location.origin}${API_BASE ? html` <a class="small" href="?api=same">usar este mismo</a>` : ''}</dd>
      <dt>Versión</dt><dd>${r.loading ? html`<${Skeleton} w=${80} />` : r.data?.version || (r.error ? html`<span class="muted">sin datos (${r.error.status === 404 ? 'falta /api/health' : r.error.message})</span>` : '—')}</dd>
      ${r.data?.uptime_s != null ? html`<dt>Encendido hace</dt><dd>${fmtUptime(r.data.uptime_s)}</dd>` : null}
      <dt>Acceso</dt><dd>${r.data?.auth_required ? 'Con token de administrador' : 'Abierto (sin ADMIN_TOKEN)'}</dd>
    </dl>
    ${hasTok ? html`<${Button} kind="ghost" icon="lock" onClick=${logout}>Cerrar sesión en este navegador</${Button}>` : null}
  </section>`;
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function Ajustes() {
  return html`<div class="view view-ajustes">
    <div class="view-head"><h1>Ajustes</h1></div>
    <${Maintenance} />
    <${Backups} />
    <${Credentials} />
    <${Webhooks} />
    <${PanelInfo} />
  </div>`;
}
