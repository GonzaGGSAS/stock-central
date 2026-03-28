# Stock Central — Gestor de Stock para Tiendanube

Sincronizá múltiples productos/variantes bajo un mismo SKU central.
Cuando se paga una orden → el stock se descuenta automáticamente de TODAS las variantes vinculadas.

---

## Estructura

```
stock-central/
├── server.js          ← Backend Node.js (API + webhook receiver)
├── package.json
├── data/
│   └── db.json        ← Base de datos local (auto-generado)
└── frontend/
    └── App.jsx        ← Frontend React
```

---

## Setup paso a paso

### 1. Instalar dependencias

```bash
npm install express cors body-parser lowdb@1.0.0 node-fetch
```

### 2. Levantar el servidor

```bash
node server.js
# Corre en http://localhost:3001
```

### 3. Exponer con ngrok (desarrollo local)

```bash
ngrok http 3001
# Te da algo como: https://abc123.ngrok.io
```

### 4. Obtener credenciales de Tiendanube

1. Ir a **partners.tiendanube.com**
2. Crear app con permisos: read_products, write_products, read_orders
3. Instalarla en tu tienda
4. Obtenés: access_token + user_id (= store_id)

### 5. Configurar la app

- Abrí el frontend
- Ingresá Store ID y Access Token
- Pegá la URL pública para registrar webhooks

---

## Deploy en producción

### Railway (recomendado)
```bash
npm install -g @railway/cli && railway login && railway init && railway up
```

### Render
- Build: `npm install` / Start: `node server.js`

---

## Flujo automático

```
Cliente paga → Tiendanube → webhook order/paid → Stock Central
  → descuenta stock central
  → actualiza TODAS las variantes vinculadas vía API
```

Cancelaciones: el stock se restaura automáticamente.

---

## Endpoints principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/skus | Listar SKUs |
| POST | /api/skus | Crear SKU |
| PUT | /api/skus/:sku/stock | Ajustar stock |
| DELETE | /api/skus/:sku | Eliminar SKU |
| POST | /api/skus/:sku/variants | Vincular variante |
| POST | /api/skus/:sku/sync | Forzar sync manual |
| POST | /webhook/order | Receptor de webhooks |
