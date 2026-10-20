// Kit de prueba real (/api/admin/test-kit) contra el TN falso
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, waitFor } = require('./helpers');

let sc;
test.before(async () => { sc = await startServer({}); });
test.after(async () => { await sc.close(); });

test('crea dos productos en TN que comparten 1 unidad, reserva apaga el otro diseño, DELETE limpia', async () => {
  await sc.reset({});
  const c = await sc.api('POST', '/api/admin/test-kit');
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.tn.length, 2);
  assert.deepEqual(c.body.tn.map(x => x.tn_stock), [1, 1]);
  assert.equal((await sc.api('POST', '/api/admin/test-kit')).status, 409);

  const [a, b] = c.body.tn;
  assert.equal((await sc.api('POST', '/api/reserve', { sessionId: 'prueba', variant_id: a.variant_id, qty: 1 })).status, 200);
  await waitFor(async () => (await sc.api('GET', '/api/admin/test-kit')).body.tn[1].tn_stock === 0);
  const st = (await sc.api('GET', '/api/admin/test-kit')).body;
  assert.equal(st.tn[0].tn_stock, 1);
  assert.equal(st.sc.disponible, 0);
  assert.equal((await sc.api('POST', '/api/reserve', { sessionId: 'prueba', variant_id: b.variant_id, qty: 1 })).status, 409);

  const d = await sc.api('DELETE', '/api/admin/test-kit');
  assert.equal(d.status, 200);
  assert.equal(sc.tn.getProduct(Number(a.product_id)), null);
  assert.equal((await sc.api('GET', '/api/admin/test-kit')).body.exists, false);
});
