/**
 * ============================================================
 *  AUTENTICACIÓN OAuth 2.0 / OpenID Connect CON GOOGLE
 *  Flujo: Google Identity Services (GIS) — 100% frontend, sin backend
 * ============================================================
 *
 * Por qué GIS y no "Authorization Code" clásico:
 * El flujo OAuth 2.0 Authorization Code requiere un `client_secret`
 * para canjear el `code` por el token. Un secreto NUNCA debe vivir en
 * código que se ejecuta en el navegador (cualquier usuario podría verlo
 * en las DevTools). Como pediste "solo frontend, sin servidor", la única
 * forma correcta y segura de validar identidad con Google es esta:
 * Google te entrega directamente un ID Token (JWT) firmado por ellos,
 * que tú validas en el cliente (o, mejor aún, en un backend si algún
 * día lo agregas).
 *
 * Qué necesitas antes de usar esto:
 * 1. Ir a https://console.cloud.google.com/apis/credentials
 * 2. Crear credenciales -> "ID de cliente de OAuth" -> tipo "Aplicación web"
 * 3. En "Orígenes de JavaScript autorizados" agregar tu dominio
 *    (ej: http://localhost:5500, https://tu-dominio.com)
 * 4. Copiar el Client ID y pegarlo abajo en CONFIG.CLIENT_ID
 *
 * ------------------------------------------------------------
 */

const GoogleAuth = (function () {
  "use strict";

  const CONFIG = {
    CLIENT_ID: "TU_CLIENT_ID.apps.googleusercontent.com", // <-- reemplazar
    GIS_SRC: "https://accounts.google.com/gsi/client",
    SCOPES: "openid email profile", // scopes de identidad (OIDC)
  };

  let onLoginSuccess = null;
  let onLoginError = null;
  let currentSession = null; // { idToken, payload, expiresAt }

  // ---------- 1. Cargar el script de Google dinámicamente ----------
  function loadGisScript() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const script = document.createElement("script");
      script.src = CONFIG.GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("No se pudo cargar Google Identity Services"));
      document.head.appendChild(script);
    });
  }

  // ---------- 2. Decodificar el JWT (ID Token) ----------
  // Nota: esto SOLO decodifica el payload, no verifica la firma.
  // La verificación real de firma se hace en verifyIdToken() más abajo.
  function decodeJwt(token) {
    try {
      const base64Url = token.split(".")[1];
      const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split("")
          .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
          .join("")
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  // ---------- 3. Validaciones básicas del token (claims) ----------
  function isTokenStructurallyValid(payload) {
    if (!payload) return false;
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== CONFIG.CLIENT_ID) return false; // el token es para tu app
    if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return false;
    if (payload.exp && payload.exp < now) return false; // expirado
    if (payload.iat && payload.iat > now + 60) return false; // emitido "en el futuro"
    return true;
  }

  // ---------- 4. Verificación de firma contra los servidores de Google ----------
  // Esto SÍ confirma que el token es auténtico (no falsificado).
  // Ideal: hacer esto en un backend. Como no hay backend, se usa el
  // endpoint público de verificación de Google (solo lectura, sin secretos).
  async function verifyIdToken(idToken) {
    try {
      const res = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
      );
      if (!res.ok) return { valid: false, reason: "Token rechazado por Google" };
      const info = await res.json();
      if (info.aud !== CONFIG.CLIENT_ID) {
        return { valid: false, reason: "El token no fue emitido para esta aplicación" };
      }
      return { valid: true, info };
    } catch (e) {
      return { valid: false, reason: "Error de red al verificar el token" };
    }
  }

  // ---------- 5. Callback que dispara Google al autenticar ----------
  async function handleCredentialResponse(response) {
    const idToken = response.credential;
    const payload = decodeJwt(idToken);

    if (!isTokenStructurallyValid(payload)) {
      onLoginError && onLoginError("Token inválido o expirado");
      return;
    }

    // [MEJORA] nonce: el token debe corresponder a ESTE intento de login (evita reutilizar tokens robados)
    const expectedNonce = sessionStorage.getItem("g_nonce");
    sessionStorage.removeItem("g_nonce");
    if (!expectedNonce || payload.nonce !== expectedNonce) {
      onLoginError && onLoginError("Token no corresponde a este intento de inicio de sesión");
      return;
    }
    // [MEJORA] solo correos verificados por Google
    if (payload.email_verified !== true) {
      onLoginError && onLoginError("El correo de Google no está verificado");
      return;
    }

    const verification = await verifyIdToken(idToken);
    if (!verification.valid) {
      onLoginError && onLoginError(verification.reason);
      return;
    }

    currentSession = {
      idToken,
      payload,
      expiresAt: payload.exp * 1000,
    };

    // [MEJORA] El idToken ya NO se guarda en el navegador: la sesión de la app
    // la crea auth.js (cifrada, con caducidad). Solo queda en memoria.

    onLoginSuccess &&
      onLoginSuccess({
        email: payload.email,
        emailVerified: payload.email_verified,
        name: payload.name,
        picture: payload.picture,
        sub: payload.sub, // ID único e inmutable del usuario en Google
      });
  }

  // ---------- 6. Inicializar y mostrar el botón / prompt ----------
  async function init({ buttonContainerId, onSuccess, onError, usePrompt = false } = {}) {
    onLoginSuccess = onSuccess || null;
    onLoginError = onError || null;

    await loadGisScript();

    if (CONFIG.CLIENT_ID.includes("TU_CLIENT_ID")) {
      console.warn("[GoogleAuth] Configura CONFIG.CLIENT_ID con tu Client ID real de Google Cloud Console.");
    }

    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    sessionStorage.setItem("g_nonce", nonce);

    google.accounts.id.initialize({
      client_id: CONFIG.CLIENT_ID,
      nonce,
      callback: handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    if (buttonContainerId) {
      const container = document.getElementById(buttonContainerId);
      if (container) {
        google.accounts.id.renderButton(container, {
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "pill",
          locale: "es",
        });
      }
    }

    if (usePrompt) {
      google.accounts.id.prompt(); // muestra el "One Tap" de Google
    }
  }

  // ---------- 7. Restaurar sesión ----------
  // [MEJORA] La sesión persistente la gestiona auth.js; aquí solo se expone la de memoria.
  function restoreSession() {
    return currentSession ? currentSession.payload : null;
  }

  // ---------- 8. Cerrar sesión ----------
  function logout() {
    currentSession = null;
    if (window.google && window.google.accounts) {
      google.accounts.id.disableAutoSelect();
    }
  }

  function getSession() {
    return currentSession;
  }

  function isConfigured() {
    return !CONFIG.CLIENT_ID.includes("TU_CLIENT_ID");
  }

  return { init, restoreSession, logout, getSession, verifyIdToken, isConfigured };
})();

/**
 * ------------------------------------------------------------
 * EJEMPLO DE USO
 * ------------------------------------------------------------
 *
 * <div id="googleSignInDiv"></div>
 *
 * <script src="google-oauth.js"></script>
 * <script>
 *   // Al cargar la página: intenta restaurar sesión previa
 *   const payloadPrevio = GoogleAuth.restoreSession();
 *   if (payloadPrevio) {
 *     iniciarApp(payloadPrevio);
 *   } else {
 *     GoogleAuth.init({
 *       buttonContainerId: "googleSignInDiv",
 *       onSuccess: (user) => {
 *         console.log("Usuario validado:", user.email, user.name);
 *         iniciarApp(user);
 *       },
 *       onError: (motivo) => {
 *         alert("No se pudo validar la sesión: " + motivo);
 *       },
 *     });
 *   }
 *
 *   function iniciarApp(user) {
 *     // aquí reemplazas tu login manual (USERS hardcodeado) por esto
 *   }
 *
 *   document.getElementById("logoutBtn").addEventListener("click", () => {
 *     GoogleAuth.logout();
 *     location.reload();
 *   });
 * </script>
 */

/**
 * ============================================================
 *  EXTRA (opcional): utilidades PKCE
 *  Úsalas SOLO si en el futuro agregas un backend y quieres el
 *  flujo Authorization Code + PKCE completo (más control sobre
 *  scopes de APIs de Google como Drive, Calendar, etc.)
 * ============================================================
 */
const PKCE = {
  generateVerifier(length = 64) {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode(...array))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  },

  async generateChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  },

  // Redirige a Google para iniciar el flujo Authorization Code + PKCE
  // (el intercambio del "code" por el token debe hacerse en tu backend)
  async redirectToGoogleAuth({ clientId, redirectUri, scope = "openid email profile" }) {
    const verifier = this.generateVerifier();
    sessionStorage.setItem("pkce_verifier", verifier);
    const challenge = await this.generateChallenge(verifier);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  },
};