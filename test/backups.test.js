// Copias de seguridad diarias de la base (runBackup / maybeBackup / endpoints)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-backups-'));
process.env.SC_BACKUP_DIR = BACKUP_DIR;
process.env.SC_BACKUP_KEEP = '14';

const { startServer, remeraWorld } = require('./helpers');

let sc;
test.before(async () => { sc = await startServer(remeraWorld()); });
test.after(async () => {
  await sc.close();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

function clearDir() {
  for (const f of fs.readdirSync(BACKUP_DIR)) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

test('runBackup escribe una copia con el estado actual y marca la fecha', async () => {
  await sc.reset(remeraWorld());
  clearDir();
  const r = sc.runBackup();
  assert.match(r.file, /^db-\d{4}-\d{2}-\d{2}\.json$/);
  const saved = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, r.file), 'utf8'));
  assert.ok(Array.isArray(saved.productos) && saved.productos.length > 0, 'la copia tiene los productos');
  assert.equal(saved.config.access_token, 'test', 'la copia local es completa (se puede restaurar)');
  assert.ok(sc.db.get('meta.last_backup_at').value());
  assert.ok(!fs.readdirSync(BACKUP_DIR).some(f => f.endsWith('.tmp')), 'no quedan temporales');
});

test('rotación: quedan solo las 14 copias más nuevas', async () => {
  clearDir();
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(BACKUP_DIR, `db-2020-01-${String(d).padStart(2, '0')}.json`), '{}');
  fs.writeFileSync(path.join(BACKUP_DIR, 'otro-archivo.txt'), 'no se toca');
  const r = sc.runBackup();
  const left = fs.readdirSync(BACKUP_DIR).filter(f => /^db-/.test(f)).sort();
  assert.equal(left.length, 14);
  assert.ok(left.includes(r.file), 'la copia de hoy se conserva');
  assert.ok(!left.includes('db-2020-01-01.json'), 'la más vieja se borra');
  assert.ok(fs.existsSync(path.join(BACKUP_DIR, 'otro-archivo.txt')), 'archivos ajenos no se tocan');
});

test('maybeBackup: no repite si la última tiene menos de 24 h; sí si es vieja o no hay copias', async () => {
  clearDir();
  assert.ok(sc.maybeBackup(), 'sin copias → hace una');
  assert.equal(sc.maybeBackup(), null, 'recién hecha → no repite');
  sc.db.set('meta.last_backup_at', new Date(Date.now() - 25 * 3600e3).toISOString()).write();
  assert.ok(sc.maybeBackup(), 'más de 24 h → hace otra');
});

test('GET/POST /api/admin/backups lista y crea copias', async () => {
  clearDir();
  const created = await sc.api('POST', '/api/admin/backups');
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  const list = await sc.api('GET', '/api/admin/backups');
  assert.equal(list.status, 200);
  assert.equal(list.body.backups.length, 1);
  assert.equal(list.body.backups[0].file, created.body.file);
  assert.equal(list.body.keep, 14);
  assert.ok(list.body.last_backup_at);
  const ov = await sc.api('GET', '/api/overview');
  assert.ok(ov.body.health.last_backup_at, 'overview informa el último backup');
});

test('GET /api/admin/backup sin ADMIN_TOKEN configurado → 403 (no expone la base)', async () => {
  const r = await sc.api('GET', '/api/admin/backup');
  assert.equal(r.status, 403);
});

test('GET /api/admin/backup con ADMIN_TOKEN: pide token, descarga la base sin el token de TN', () => {
  const child = `
    const fs = require('fs'), os = require('os'), path = require('path');
    for (const k of ['log','info','warn','error','debug']) console[k] = () => {};
    (async () => {
      const dbPath = path.join(os.tmpdir(), 'sc-bk-auth-' + process.pid + '.json');
      fs.writeFileSync(dbPath, JSON.stringify({ config: { access_token: 'secreto-tn', store_id: '1', webhook_registered: true },
        productos: [{ id: 'REMERA', nombre: 'Remera', variantes: [] }], reservations: [], matchs: [] }));
      Object.assign(process.env, { DB_PATH: dbPath, TN_API_BASE: 'http://127.0.0.1:9', TN_THROTTLE: 'off', ADMIN_TOKEN: 'tok-bk',
        SC_BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bk-')) });
      const sc = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
      const srv = sc.app.listen(0, '127.0.0.1');
      await new Promise(r => srv.once('listening', r));
      const base = 'http://127.0.0.1:' + srv.address().port;
      const noTok = await fetch(base + '/api/admin/backup');
      const withTok = await fetch(base + '/api/admin/backup', { headers: { Authorization: 'Bearer tok-bk' } });
      const body = await withTok.text();
      process.stdout.write('RESULT' + JSON.stringify({ noTok: noTok.status, withTok: withTok.status,
        disposition: withTok.headers.get('content-disposition'), leaked: body.includes('secreto-tn'),
        productos: JSON.parse(body).productos.length }));
      srv.close(); try { fs.unlinkSync(dbPath); } catch (_) {}
      process.exit(0);
    })().catch(e => { process.stdout.write('ERROR' + e.stack); process.exit(1); });
  `;
  const r = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 30000 });
  const out = r.stdout || '';
  assert.ok(out.includes('RESULT'), `el proceso hijo falló: ${out}${r.stderr}`);
  const res = JSON.parse(out.slice(out.indexOf('RESULT') + 6));
  assert.equal(res.noTok, 401);
  assert.equal(res.withTok, 200);
  assert.match(res.disposition, /attachment; filename="stock-central-.*\.json"/);
  assert.equal(res.leaked, false, 'la descarga no incluye el token de Tiendanube');
  assert.equal(res.productos, 1);
});
