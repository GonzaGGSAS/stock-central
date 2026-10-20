// Formatos: fechas en hora argentina, números y plata.
const TZ = 'America/Argentina/Buenos_Aires';
const partsFmt = new Intl.DateTimeFormat('es-AR', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const weekdayFmt = new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'short' });
const numFmt = new Intl.NumberFormat('es-AR');

function parts(d) {
  const o = {};
  for (const p of partsFmt.formatToParts(d)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
const toDate = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; };
const sameDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day;

/** "hoy 16:31" · "ayer 08:34" · "17/10 13:10" · "17/10/25 13:10" */
export function fmtDate(v) {
  const d = toDate(v);
  if (!d) return '—';
  const p = parts(d);
  const now = parts(new Date());
  const yest = parts(new Date(Date.now() - 864e5));
  const hm = `${p.hour}:${p.minute}`;
  if (sameDay(p, now)) return `hoy ${hm}`;
  if (sameDay(p, yest)) return `ayer ${hm}`;
  if (p.year === now.year) return `${p.day}/${p.month} ${hm}`;
  return `${p.day}/${p.month}/${p.year.slice(2)} ${hm}`;
}

/** Clave de día (AAAA-MM-DD en hora argentina) para agrupar. */
export function dayKey(v) {
  const d = toDate(v);
  if (!d) return '';
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "Hoy" · "Ayer" · "vie 17/10" */
export function dayLabel(v) {
  const d = toDate(v);
  if (!d) return '';
  const p = parts(d);
  if (sameDay(p, parts(new Date()))) return 'Hoy';
  if (sameDay(p, parts(new Date(Date.now() - 864e5)))) return 'Ayer';
  const wd = weekdayFmt.format(d).replace('.', '');
  const now = parts(new Date());
  return `${wd} ${p.day}/${p.month}${p.year !== now.year ? '/' + p.year.slice(2) : ''}`;
}

export const fmtNum = (n) => (n == null || n === '' || isNaN(Number(n)) ? '—' : numFmt.format(Number(n)));

export function fmtMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return String(v);
  return '$' + numFmt.format(Math.round(n));
}

export function fmtDelta(d) {
  const n = Number(d);
  if (!n) return '';
  return (n > 0 ? '+' : '−') + numFmt.format(Math.abs(n));
}

export const plural = (n, one, many) => `${fmtNum(n)} ${Number(n) === 1 ? one : many}`;

/** Normaliza para búsqueda: minúsculas y sin tildes. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tono de un número de stock disponible: 0 → bad, 1..3 → warn, resto → ok. */
export function stockTone(n) {
  const v = Number(n) || 0;
  if (v <= 0) return 'bad';
  if (v <= 3) return 'warn';
  return 'ok';
}
