// Pantalla de ingreso cuando el servidor pide ADMIN_TOKEN (respuesta 401).
import { html, useState } from '../../vendor/htm-preact-3.1.1.js';
import { api, setToken, getToken } from '../lib/api.js';
import { Button, ErrorBox, Field } from '../ui/components.js';

export function Login({ onDone, Logo }) {
  const [tok, setTok] = useState('');
  const [st, setSt] = useState({ loading: false, error: null });
  const had = !!getToken();
  const submit = async (e) => {
    e.preventDefault();
    if (!tok.trim()) return;
    setSt({ loading: true, error: null });
    const prev = getToken();
    setToken(tok.trim());
    try {
      await api('/api/config');
      setSt({ loading: false, error: null });
      onDone();
    } catch (err) {
      if (err.status === 401) setToken(prev || null);
      setSt({ loading: false, error: err.status === 401 ? 'Token incorrecto. Revisalo y probá de nuevo.' : err });
    }
  };
  return html`<main class="login">
    <form class="login-card" onSubmit=${submit}>
      <${Logo} />
      <h1>Stock Central</h1>
      <p class="muted">${had ? 'El token guardado ya no sirve. Ingresá el nuevo.' : 'Este panel está protegido. Ingresá el token de administrador.'}</p>
      <${Field} label="Token de administrador">
        <input type="password" autocomplete="current-password" value=${tok} onInput=${(e) => setTok(e.currentTarget.value)} required data-autofocus autofocus />
      </${Field}>
      <${ErrorBox} compact error=${st.error} />
      <${Button} type="submit" kind="primary" loading=${st.loading} busyText="Verificando…">Ingresar</${Button}>
      <p class="muted small">Se guarda solo en este navegador.</p>
    </form>
  </main>`;
}
