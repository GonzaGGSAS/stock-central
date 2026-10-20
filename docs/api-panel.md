# Stock Central — contrato de API para el panel

El panel vive en `public/panel/` y lo sirve el mismo backend en `/` (Railway).
Todas las rutas son relativas al mismo origen (`/api/...`).

## Reglas generales

- Respuesta de error (cualquier status no 2xx): `{ "error": "mensaje en español para mostrar tal cual", "code": "opcional", "details": any }`.
- Auth opcional: si el server tiene `ADMIN_TOKEN`, todo `/api/*` (salvo `/api/health`, `POST /api/reserve`, `DELETE /api/reserve/*`) pide
  `Authorization: Bearer <token>`. El SSE acepta `?token=<token>`. Sin token → `401 { error: "No autorizado", code: "unauthorized" }`.
  El panel guarda el token en `localStorage` (`sc_admin_token`) y muestra una pantalla de ingreso si recibe 401.
- Fechas: ISO 8601 (UTC). El panel las muestra en hora argentina.

## Salud y resumen

`GET /api/health` → `{ ok: true, auth_required: bool, version: string, uptime_s: number }`

`GET /api/overview` →
```json
{
  "store": { "id": "1443972", "name": "Minch", "logo_url": "https://..." },
  "kpis": {
    "productos": 12, "variantes": 80, "unidades": 340,
    "sin_stock": 5, "stock_bajo": 9,
    "reservas_activas": 3, "unidades_reservadas": 4,
    "ventas_hoy": 6, "unidades_vendidas_hoy": 8, "unidades_vendidas_7d": 41
  },
  "alerts_open": 2,
  "health": { "tn_configured": true, "webhooks_registered": true, "last_webhook_at": "...", "last_reconcile_at": "..." },
  "jobs": [ /* jobs en curso, mismo formato que GET /api/jobs/:id */ ]
}
```
`stock_bajo` = variantes con 1..3 disponibles. `sin_stock` = disponibles 0.

## Stock

`GET /api/productos?lite=1` →
```json
[{
  "id": "REMERA_NEGRA", "nombre": "Remera negra",
  "unidades": 14, "disponibles": 13, "sin_stock": 1,
  "variantes": [{
    "id": "var_1", "label": "4 (L/XL)",
    "stock": 1,          // stock físico en SC
    "reservado": 1,      // unidades en carritos activos (no descontadas)
    "disponible": 0,     // stock - reservado (lo que puede comprar otra persona)
    "links": [{ "product_id": "1", "variant_id": "11", "label": "REMERA \"I CRY A LOT\" · Negro / 4", "tn_stock": 0 }],
    "matchs": 2,         // cuántos combos usan esta variante
    "last_movement_at": "...", "last_sale_at": "...", "vendidas_7d": 3,
    "sync_error": null   // o "mensaje" si el último sync a TN falló
  }]
}]
```
`tn_stock` es lo último que SC empujó a ese producto de TN (puede ser menor que `stock` si hay reservas en otro diseño).

`GET /api/productos` (sin lite) sigue existiendo (formato viejo, con logs completos).

`POST /api/productos/import` `{ tn_product_id, id?, nombre? }` → crea el producto en SC con una variante por cada variante de TN, vinculadas 1 a 1, con el stock actual de TN. Devuelve el producto.
`POST /api/productos` `{ id, nombre }` → producto vacío.
`DELETE /api/productos/:id`
`POST /api/productos/:id/sync-variantes` → importa variantes nuevas de TN `{ ok, added, skipped }`.
`POST /api/productos/:id/variantes` `{ label, stock }`
`DELETE /api/productos/:id/variantes/:varId`

`PUT /api/productos/:id/variantes/:varId/stock` `{ delta?: number, absolute?: number, reason?: string, sync: true }`
→ `{ ok, stock, sync: { ok, updated, total, errors: [{ variant_id, label, error }] } }`

`POST /api/productos/:id/variantes/:varId/links` `{ product_id, variant_id, label }` (vincular otro producto de TN al mismo stock)
`DELETE /api/productos/:id/variantes/:varId/links/:variant_id`

`POST /api/productos/:id/variantes/:varId/sync` → sync a TN. Con `Accept: text/event-stream` manda progreso:
`data: {"type":"progress","current":1,"total":3,"label":"...","ok":true}` … `data: {"type":"done","ok":true,"updated":3,"total":3,"errors":[]}` o `{"type":"error","error":"..."}`.

`GET /api/productos/:id/variantes/:varId/log?limit=200` → `[actividad]` (mismo formato que `/api/activity` items).

`GET /api/tn-products` → productos de TN `[{ id, name: {es}, variants: [{ id, values: [{es}], stock, sku }] }]` (lento, cachear en el panel).

## Matchs (combos)

`GET /api/matchs?lite=1` →
```json
[{
  "id": "match_1", "nombre": "BUZOS CHANDLER + MONICA", "tn_match_product_id": "99",
  "precio": "50000", "precio_promocional": null, "imagen_url": null,
  "producto1": { "tn_product_id": "1", "nombre": "BUZO \"CHANDLER\"" },
  "producto2": { "tn_product_id": "2", "nombre": "BUZO \"MONICA\"" },
  "combos_total": 16, "combos_con_stock": 9,
  "combos": [{ "label": "S / M", "tn_variant_id": "991", "stock": 2 }]
}]
```
`POST /api/matchs` `{ nombre, producto1: { tn_product_id, nombre? }, producto2: {...}, precio?, precio_promocional?, imagen_url? }`
`PUT /api/matchs/:id` `{ nombre?, precio?, precio_promocional?, imagen_url? }`
`DELETE /api/matchs/:id`
`PUT /api/matchs/:id/sync-stock` → `{ ok, updated }`

## Actividad

`GET /api/activity?limit=100&before=<iso>&category=all|sale|cart|stock|error&q=<texto>&include_sync=0`
→
```json
{
  "items": [{
    "id": "string estable", "ts": "...", "action": "sale",
    "category": "sale",               // sale | cart | stock | sync | error
    "title": "Venta",                 // etiqueta corta en español
    "delta": -1, "stock": 0,
    "productoId": "REMERA_NEGRA", "producto": "Remera negra",
    "varianteId": "var_1", "variante": "4 (L/XL)",
    "order_id": "2097728328", "client": "Florencia P.", "email": "...",
    "detail": "REMERA \"I CRY A LOT\" (Negro, 4)"   // texto libre ya limpio
  }],
  "next_before": "iso o null"
}
```
Acciones posibles: `sale`, `return`, `payment_confirmed`, `cart_added`, `cart_released`, `cart_expired`, `cart_rejected`,
`reserved` / `reservation_released` / `reservation_expired` (legado de matchs), `set`, `add`, `subtract`, `created`,
`sync`, `sanitized`, `reconciled`, `oversold`.

## Alertas (errores que el panel tiene que mostrar)

`GET /api/alerts?include_dismissed=0` →
```json
[{
  "id": "al_...", "ts": "...", "type": "oversold",
  "severity": "error",              // error | warning
  "title": "Sobreventa en Remera negra · 4 (L/XL)",
  "detail": "La orden #2097728328 pidió 2 y había 1.",
  "order_id": "2097728328", "productoId": "...", "varianteId": "...", "variant_id": "...",
  "count": 1, "dismissed": false
}]
```
Tipos: `oversold` (vendió más de lo que había), `unlinked_sale` (venta de un producto de TN que no está vinculado en SC),
`sync_error` (no se pudo actualizar TN), `cart_rejected` (alguien quiso agregar algo sin stock disponible),
`webhook_error`, `discrepancy` (TN tenía otro número que SC; se corrigió TN).
`POST /api/alerts/:id/dismiss`, `POST /api/alerts/dismiss-all`

## Tareas largas (con progreso, sin refrescar)

`POST /api/jobs` `{ type: "resync-matchs" | "repair-matchs" | "reconcile" | "sync-product" | "sync-all", productoId? }` → `{ id }`
`GET /api/jobs/:id` →
```json
{ "id": "job_...", "type": "resync-matchs", "label": "Actualizar stock de combos",
  "status": "running", "progress": { "current": 3, "total": 24, "message": "BUZOS CHANDLER + MONICA" },
  "started_at": "...", "finished_at": null, "result": null, "error": null, "errors": [] }
```
`status`: `running` | `done` | `error`. `GET /api/jobs` → últimos 20.

## Tiempo real

`GET /api/events` (SSE). Eventos `event: change` con `data: {"topic":"stock|activity|alerts|jobs|matchs","productoId"?,"jobId"?}`.
Comentario de heartbeat cada 25 s. El panel refresca solo la parte afectada (con debounce) y reconecta solo si se corta.

## Config

`GET /api/config` → `{ store_id, has_token, webhook_registered }`
`POST /api/config` `{ access_token, store_id }`
`POST /api/config/test` → `{ ok, store_name }`
`GET /api/admin/webhooks` → lista de TN
`POST /api/admin/webhooks/clean-and-register` `{ webhook_url }`
