// Datos de la tienda para el encabezado (nombre y logo), recordados entre visitas.
import { createStore } from './store.js';

export const DEFAULT_LOGO = 'https://acdn-us.mitiendanube.com/stores/001/443/972/themes/common/logo-1516620265-1747438419-3be83f5e868d070c706e3e78edcc8ad01747438419-320-0.webp';
const LS = 'sc_store_info';

function load() {
  try { return { name: 'Minch', logo_url: DEFAULT_LOGO, ...(JSON.parse(localStorage.getItem(LS) || 'null') || {}) }; }
  catch { return { name: 'Minch', logo_url: DEFAULT_LOGO }; }
}

export const storeInfo = createStore(load());
storeInfo.subscribe((s) => {
  try { localStorage.setItem(LS, JSON.stringify({ name: s.name, logo_url: s.logo_url, id: s.id })); } catch { /* */ }
});
