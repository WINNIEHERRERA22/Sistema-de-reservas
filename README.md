# RestoApp — Reservas, comandas e inventario (frontend seguro)

## Cómo correrlo
El cifrado (Web Crypto) exige `https://` o `localhost`; no abras el archivo con doble clic.

```bash
python -m http.server 5500      # o la extensión Live Server de VS Code
# abrir http://localhost:5500
```

Usuarios demo (piden cambiar la contraseña al primer ingreso):
`admin/admin123 · mesero/mesero123 · cocina/cocina123 · despacho/despacho123`

## Estructura
```
index.html            Pantallas y política CSP
css/styles.css
js/crypto.js          AES-GCM (clave no extraíble en IndexedDB), PBKDF2
js/storage.js         Store cifrado, validadores (V), bitácora (Audit)
js/twofa.js           TOTP RFC 6238 (Google Authenticator)
js/auth.js            Login 2 pasos, bloqueo, sesión cifrada, roles
js/google-oauth.js    Google Identity Services (con nonce y email_verified)
js/modules.js         Reglas de negocio (Ops) y vistas (Views)
js/app.js             Controlador principal
```

## Flujo de negocio
Reserva → Pedido (descuenta inventario por receta) → Cocina (pendiente → preparando → listo) → Despacho (pendiente → en ruta → entregado) → Cerrar pedido.

## Activar Google
1. Google Cloud Console → Credenciales → ID de cliente OAuth → Aplicación web.
2. Orígenes autorizados: `http://localhost:5500` y tu dominio.
3. Pega el Client ID en `CONFIG.CLIENT_ID` de `js/google-oauth.js` (el Client ID es público; el `client_secret` jamás va aquí).
4. Entra como admin → Usuarios → escribe el correo de Google autorizado de cada usuario.
Si el botón no aparece, revisa la CSP en `index.html` (los dominios de Google).

## Seguridad: qué hay y qué NO garantiza
Incluye: cifrado AES-GCM con detección de manipulación, contraseñas con PBKDF2+sal, 2FA TOTP con anti-reutilización, bloqueo tras 5 intentos, sesión cifrada con caducidad (15 min de inactividad / 8 h), validación por lista permitida, DOM sin innerHTML, CSP, bitácora de auditoría y permisos por rol en cada operación.

Límite real: todo corre en el navegador, así que alguien con acceso a las DevTools puede saltarse reglas o borrar el almacenamiento. Es una barrera, no una garantía. Para producción hay que mover usuarios, roles, datos y validación a un backend con base de datos. `Store` y `Ops` están aislados para facilitar esa migración.
