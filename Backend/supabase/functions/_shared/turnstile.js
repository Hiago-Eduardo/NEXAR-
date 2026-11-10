// Validação server-side do Cloudflare Turnstile (Siteverify) e do pedido de
// orçamento (Resumo.md §228). JavaScript puro com fetch injetado: a Edge
// Function usa de verdade, o Vitest com mocks.
//
// REGRA: FALHA FECHADA. Qualquer coisa que não seja um "success: true"
// inequívoco da Cloudflare -- token ausente, recusado, vencido, já usado,
// hostname fora da lista, Cloudflare fora do ar, timeout, secret ausente --
// recusa a operação. O widget aparecer na tela não prova nada.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const SITEVERIFY_TIMEOUT_MS = 10000;
// Tamanho máximo de token documentado pela Cloudflare.
const MAX_TOKEN_LENGTH = 2048;

/**
 * @returns {Promise<{ ok: true, hostname: string|null, action: string|null }
 *                 | { ok: false, reason: string, codes: string[] }>}
 *   reason: missing_secret | missing_token | expired_or_used | invalid |
 *           hostname_mismatch | action_mismatch | unavailable
 */
export async function verifyTurnstile({
  secret, token, remoteip = null, allowedHostnames = [], expectedAction = null,
  fetchImpl = fetch, timeoutMs = SITEVERIFY_TIMEOUT_MS,
}) {
  if (!secret) return { ok: false, reason: "missing_secret", codes: [] };
  const t = typeof token === "string" ? token.trim() : "";
  if (!t || t.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "missing_token", codes: [] };

  const form = new URLSearchParams({ secret, response: t });
  if (remoteip) form.set("remoteip", remoteip);

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let body;
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return { ok: false, reason: "unavailable", codes: [`http_${res.status}`] };
    body = await res.json();
  } catch (error) {
    return { ok: false, reason: "unavailable", codes: [error?.name === "AbortError" ? "timeout" : "network"] };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const codes = Array.isArray(body?.["error-codes"]) ? body["error-codes"].map(String) : [];
  if (body?.success !== true) {
    if (codes.includes("timeout-or-duplicate")) return { ok: false, reason: "expired_or_used", codes };
    if (codes.includes("internal-error")) return { ok: false, reason: "unavailable", codes };
    return { ok: false, reason: "invalid", codes };
  }

  const hostname = body.hostname ? String(body.hostname).toLowerCase() : null;
  const permitidos = allowedHostnames.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (permitidos.length && (!hostname || !permitidos.includes(hostname))) {
    return { ok: false, reason: "hostname_mismatch", codes };
  }
  const action = body.action ? String(body.action) : null;
  if (expectedAction && action && action !== expectedAction) {
    return { ok: false, reason: "action_mismatch", codes };
  }
  return { ok: true, hostname, action };
}

export function parseHostnames(value) {
  return String(value || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// Mensagem para a pessoa (nunca o código interno da Cloudflare).
export function captchaReasonMessage(reason) {
  switch (reason) {
    case "expired_or_used":
      return "A verificação de segurança expirou ou já foi usada. Conclua a verificação de novo.";
    case "unavailable":
      return "Não foi possível confirmar a verificação de segurança agora. Tente de novo em instantes.";
    case "missing_secret":
      return "Verificação de segurança indisponível no servidor.";
    default:
      return "A verificação de segurança falhou. Conclua a verificação de novo.";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
export const CONTACT_LIMITS = { sender_name: 120, sender_email: 254, sender_phone: 40, message: 5000 };

/**
 * Lista branca do pedido de orçamento: só estes campos passam, com tamanho
 * máximo. created_by NUNCA vem do corpo -- é o usuário do JWT.
 */
export function validateContactRequest(input) {
  const src = input && typeof input === "object" ? input : {};
  const txt = (k) => (typeof src[k] === "string" ? src[k].trim() : "");
  const value = {
    supplier_id: txt("supplier_id"),
    sender_name: txt("sender_name"),
    sender_email: txt("sender_email"),
    sender_phone: txt("sender_phone"),
    message: txt("message"),
  };
  const errors = [];
  if (!UUID_RE.test(value.supplier_id)) errors.push("supplier_id");
  if (!value.sender_name) errors.push("sender_name");
  if (!EMAIL_RE.test(value.sender_email)) errors.push("sender_email");
  if (!value.message) errors.push("message");
  for (const [k, max] of Object.entries(CONTACT_LIMITS)) {
    if (value[k].length > max) errors.push(k);
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, value };
}
