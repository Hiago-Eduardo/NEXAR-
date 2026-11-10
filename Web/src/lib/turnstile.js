// Cloudflare Turnstile no NEXAR (Resumo.md §228) -- a parte sem React.
//
// QUEM GARANTE A PROTEÇÃO É O SERVIDOR. O widget só produz um token; quem
// recusa a requisição sem token válido é o Supabase Auth (com o CAPTCHA
// ligado no painel) ou a Edge Function submit-contact-request (Siteverify).
// Por isso o lado do navegador pode "falhar aberto": sem site key
// configurada, nada aparece e nada é bloqueado aqui -- é exatamente o
// comportamento de antes, e o Supabase decide se aceita.
//
// Chaves de TESTE oficiais da Cloudflare (só para dev/e2e, nunca produção):
//   1x00000000000000000000AA  visível, sempre passa
//   2x00000000000000000000AB  visível, sempre falha
//   3x00000000000000000000FF  força desafio interativo
// Elas geram o token XXXX.DUMMY.TOKEN.XXXX, que uma secret de produção
// recusa.

export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const SCRIPT_TIMEOUT_MS = 15000;

const TEST_KEY_RE = /^[123]x0{20}[A-Z]{2}$/;

export function isTestSiteKey(key) {
  return TEST_KEY_RE.test(String(key || "").trim());
}

/**
 * Lê a site key do ambiente do Vite. Em build de produção, chave de teste é
 * tratada como AUSENTE (e avisa no console): o token dela é recusado pela
 * secret real, e o resultado seria ninguém conseguir entrar.
 */
// `import.meta.env` LITERAL: o Vite só injeta as variáveis quando acha esse
// texto exato -- um cast com parênteses ((import.meta).env) passa no tsc mas
// chega undefined no navegador (aconteceu, §228).
export function resolveSiteKey(env = import.meta.env, log = console) {
  const key = String(env?.VITE_TURNSTILE_SITE_KEY || "").trim();
  if (!key) return null;
  if (env?.PROD && isTestSiteKey(key)) {
    log?.error?.("[turnstile] VITE_TURNSTILE_SITE_KEY é uma chave de TESTE da Cloudflare num build de produção; CAPTCHA desativado no navegador.");
    return null;
  }
  return key;
}

// Orçamento protegido pela Edge Function: só depois de publicada a função e
// rodado o SQL (supabase/contact-request-captcha.sql). Padrão: desligado.
export function contactCaptchaEnabled(env = import.meta.env) {
  return String(env?.VITE_TURNSTILE_CONTACT_REQUIRED || "").trim() === "true";
}

let carregando = null;

/**
 * Carrega o api.js da Cloudflare UMA vez por página (promessa compartilhada).
 * Falha (bloqueador de anúncio, rede, CSP) ou demora demais -> rejeita, e a
 * próxima chamada tenta de novo.
 */
/** @param {{ doc?: any, win?: any, timeoutMs?: number }} [deps] */
export function loadTurnstileScript({ doc = globalThis.document, win = /** @type {any} */ (globalThis).window, timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  if (win?.turnstile) return Promise.resolve(win.turnstile);
  if (carregando) return carregando;

  carregando = new Promise((resolve, reject) => {
    const falhar = (motivo) => {
      carregando = null;
      reject(new Error(motivo));
    };
    const timer = setTimeout(() => falhar("timeout"), timeoutMs);
    const pronto = () => {
      clearTimeout(timer);
      if (win?.turnstile) resolve(win.turnstile);
      else falhar("missing_global");
    };

    /** @type {any} */
    let script = doc.querySelector(`script[src="${TURNSTILE_SCRIPT_URL}"]`);
    if (!script) {
      script = doc.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      doc.head.appendChild(script);
    }
    script.addEventListener("load", pronto, { once: true });
    script.addEventListener("error", () => {
      clearTimeout(timer);
      script.remove();
      falhar("network");
    }, { once: true });
  });
  return carregando;
}

// Só para os testes.
export function __resetTurnstileLoader() {
  carregando = null;
}

/**
 * Estados do desafio:
 *   disabled  sem site key: nenhum widget, nada bloqueado
 *   loading   carregando o script / renderizando
 *   ready     widget na tela, esperando a pessoa (ou o desafio automático)
 *   verified  há token válido
 *   expired   o token venceu (300 s) -- o widget renova sozinho
 *   error     o desafio falhou (rede, navegador, bot) -- reiniciar
 *   unavailable  o script não carregou -- "Tentar de novo"
 */
export const CAPTCHA_INITIAL = { status: "loading", token: null };

/**
 * @param {{ status: string, token: string | null }} state
 * @param {{ type: string, token?: string }} event
 * @returns {{ status: string, token: string | null }}
 */
export function captchaReducer(state, event) {
  switch (event.type) {
    case "disabled":
      return { status: "disabled", token: null };
    case "rendered":
      return state.status === "verified" ? state : { status: "ready", token: null };
    case "success":
      return { status: "verified", token: event.token || null };
    case "expired":
      return { status: "expired", token: null };
    case "error":
      return { status: "error", token: null };
    case "unavailable":
      return { status: "unavailable", token: null };
    // Token entregue a uma chamada: é de uso único, não serve mais.
    case "consumed":
    case "reset":
      return { status: "loading", token: null };
    default:
      return state;
  }
}

// Pode enviar o formulário? Sem CAPTCHA configurado, sempre.
export function captchaAllowsSubmit(state) {
  return state.status === "disabled" || (state.status === "verified" && !!state.token);
}

export function captchaHint(state) {
  switch (state.status) {
    case "loading":
    case "ready":
      return "Conclua a verificação de segurança para continuar.";
    case "expired":
      return "A verificação expirou. Ela será refeita automaticamente.";
    case "error":
      return "A verificação de segurança falhou. Tente de novo.";
    case "unavailable":
      return "Não foi possível carregar a verificação de segurança. Verifique sua conexão ou bloqueadores de anúncio e tente de novo.";
    default:
      return "";
  }
}

// Erro do Supabase Auth causado pelo CAPTCHA (token ausente, inválido,
// vencido ou já usado). O código é `captcha_failed`; o texto cobre versões
// sem código.
export function isCaptchaError(error) {
  if (!error) return false;
  if (error.code === "captcha_failed") return true;
  return /captcha/i.test(error.message || "");
}
