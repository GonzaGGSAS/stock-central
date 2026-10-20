# Stock Central — stock de Minch para Tiendanube

SC es la **fuente única de verdad** del stock. Tiendanube (TN) solo muestra lo que SC le empuja.
Un mismo stock interno puede venderse por varios productos de TN (diseños que salen de la misma
remera/buzo) y por combos ("Matchs").

## Correr

```bash
npm start          # http://localhost:3001 — panel en / , API en /api
npm test           # suite completa contra un Tiendanube falso (no toca la tienda)
```

Variables de entorno:

| Variable | Para qué |
|---|---|
| `PORT` | puerto (Railway lo pone solo) |
| `ACCESS_TOKEN`, `STORE_ID` | credenciales de TN (también se cargan desde el panel) |
| `ADMIN_TOKEN` | si está, el panel y la API piden ese token (el storefront sigue público) |
| `TN_APP_SECRET` | si está, se rechazan webhooks sin firma HMAC válida de TN |
| `DB_PATH` | ruta de la base (default `./data/db.json`, tiene que estar en un volumen persistente) |

## Cómo funciona el stock

- **Ventas**: el webhook `order/created` descuenta (no `order/paid`, porque las transferencias tardan).
  `order/paid` solo registra el pago; `order/cancelled` devuelve, una sola vez y solo si la orden figura
  cancelada en TN. La idempotencia es por línea de orden (`db.order_items`).
- **Carritos**: `POST /api/reserve` retiene la unidad en el diseño que eligió el cliente, sin descontar
  stock físico. A cada producto de TN se le manda `libre + lo reservado en ese producto`, así:
  - quien tiene el producto en el carrito puede pagar;
  - si queda 1 sola unidad, los demás diseños que comparten ese stock pasan a 0 y nadie (ni la misma
    persona) puede llevarse una segunda.
  Si no hay disponible responde 409. Las reservas vencen a los 30 minutos.
- **Combos**: el contenedor muestra el mínimo de los dos productos calculado desde SC. Reservar un combo
  retiene en los dos productos (todo o nada).
- **Revisión de órdenes** cada 10 min: procesa órdenes que no llegaron por webhook (deploys, caídas).
- **Ciclo cada 6 h**: revisión de órdenes → SC corrige a TN donde difiera → talles faltantes en combos →
  stock de combos.
- **Alertas** en el panel: sobreventa, ventas de productos no vinculados, errores de sync, carritos
  rechazados, discrepancias con TN.

El contrato de la API del panel está en [docs/api-panel.md](docs/api-panel.md).
