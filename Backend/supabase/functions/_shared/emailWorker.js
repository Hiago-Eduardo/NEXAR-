// Núcleo do envio de e-mails transacionais (seções 209 e 222).
//
// JavaScript puro e com dependências injetadas (claim/finish/send/sleep),
// para a Edge Function usar com o Supabase e a Brevo de verdade e os testes
// do Vitest usarem mocks -- nenhum teste manda e-mail.
//
// Modelo: o BANCO decide quem recebe o quê. Triggers gravam em
// public.email_outbox (supabase/transactional-emails.sql) a partir de
// eventos confiáveis; o destinatário é resolvido de auth.users no claim.
// Esta função só pega a fila, renderiza e entrega. Nenhuma requisição
// escolhe destinatário ou conteúdo.
//
// Provedor: Brevo (POST /v3/smtp/email, header api-key). Até a seção 221 era
// o Resend; trocado antes de qualquer deploy (Resumo.md §222).

import { renderEmail, PAYMENT_TEMPLATES, TEMPLATE_NAMES } from "./emailTemplates.js";

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Atraso entre tentativas (por número da tentativa que falhou).
const BACKOFF_SECONDS = [60, 300, 1800, 7200];
export const MAX_ATTEMPTS = 5;
export const DEFAULT_TIMEOUT_MS = 15000;
// Cota da conta esgotada (plano gratuito: limite diário): tentar de novo em
// 1 h, e não a cada minuto até o item vencer.
export const QUOTA_RETRY_SECONDS = 3600;
// A Brevo lembra a idempotencyKey por 15 ou 30 min (a documentação diverge):
// esperar 31 min garante que a chave já expirou.
export const DUPLICATE_RETRY_SECONDS = 1860;

export function isValidEmail(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value.trim());
}

// Domínios reservados (RFC 2606/6761) nunca entregam: são as contas de teste
// (ex.: teste-limites@nexar.test). Mandar para eles no modo live vira bounce
// e queima a reputação do remetente -- e o test:banco gera notificação nessas
// contas o tempo todo (Resumo.md §218, achado 5).
const RESERVED_DOMAIN_RE = /([@.](test|example|invalid|localhost)|@example\.(com|net|org))$/i;

export function isReservedDomain(value) {
  return RESERVED_DOMAIN_RE.test(String(value || "").trim());
}

// "fulano@empresa.com" -> "f***@empresa.com": o único jeito de um e-mail
// aparecer em log.
export function maskEmail(value) {
  const s = String(value || "");
  const at = s.indexOf("@");
  if (at < 1) return "***";
  return `${s[0]}***${s.slice(at)}`;
}

// Mensagens de erro do provedor podem repetir o destinatário. Tudo que vai
// para log ou para email_outbox.last_error passa por aqui.
export function maskEmailsInText(text) {
  return String(text || "").replace(/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}/g, (m) => maskEmail(m));
}

// "NEXAR <nao-responda@nexar.com.br>" ou "nao-responda@nexar.com.br" ->
// { name, email }. null se não houver um e-mail válido.
export function parseAddress(value) {
  const s = String(value || "").trim();
  if (!s) return null;
  const m = s.match(/^(.*?)\s*<([^<>]+)>$/);
  const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1").slice(0, 70) : "";
  const email = (m ? m[2] : s).trim();
  if (!isValidEmail(email)) return null;
  return name ? { name, email } : { email };
}

export class ProviderError extends Error {
  constructor(status, message, { retryAfter = null, code = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.code = code;
  }
  // duplicate: a Brevo já processou esta mesma idempotencyKey (a resposta da
  //   tentativa anterior se perdeu) -- o e-mail SAIU.
  // quota: créditos/limite diário da conta. rate_limited: 429.
  // config: chave errada, conta bloqueada, IP não autorizado.
  // transient: 5xx, rede, timeout. permanent: o e-mail em si foi recusado.
  get kind() {
    const code = String(this.code || "").toLowerCase();
    if (code === "duplicate_parameter" || code === "duplicate_request") return "duplicate";
    if (this.status === 402 || code === "not_enough_credits" || code === "insufficient credits") return "quota";
    if (this.status === 429) return "rate_limited";
    if (this.status === 401 || this.status === 403 || code === "unauthorized" || code === "permission_denied") return "config";
    if (this.status === 0 || this.status >= 500) return "transient";
    return "permanent";
  }
}

function retryAfterFrom(headers) {
  for (const h of ["retry-after", "x-sib-ratelimit-reset"]) {
    const n = Number(headers?.get?.(h));
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }
  return null;
}

/**
 * Envia UM e-mail pela Brevo.
 *
 * Idempotência: a Brevo aceita `headers.idempotencyKey` DENTRO do corpo
 * (não é header HTTP, e o "Idempotency-Key" do Resend não vale lá), exige
 * UUID e só lembra a chave por pouco tempo (a documentação fala em 15 e em
 * 30 minutos -- contamos com 15). Quem chama passa o id da linha da fila,
 * que é UUID e não muda entre tentativas. Depois que a proteção do provedor
 * expira, quem impede o reenvio é a própria fila: dedupe_key UNIQUE (o mesmo
 * evento não entra duas vezes) e linha 'sent' nunca volta a ser pega.
 */
export async function sendViaBrevo({
  apiKey, from, replyTo, to, subject, html, text, idempotencyKey,
  fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const sender = parseAddress(from);
  if (!sender) throw new ProviderError(400, "Remetente inválido (EMAIL_FROM)");
  if (idempotencyKey != null && !UUID_RE.test(String(idempotencyKey))) {
    throw new TypeError("idempotencyKey precisa ser UUID (exigência da Brevo)");
  }
  const reply = parseAddress(replyTo);

  const body = {
    sender,
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
    ...(reply ? { replyTo: reply } : {}),
    ...(idempotencyKey ? { headers: { idempotencyKey: String(idempotencyKey) } } : {}),
  };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(BREVO_URL, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new ProviderError(0, `Tempo esgotado (${timeoutMs} ms)`);
    throw new ProviderError(0, `Falha de rede: ${error?.message || "erro desconhecido"}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new ProviderError(res.status, maskEmailsInText(json?.message || json?.code || `HTTP ${res.status}`).slice(0, 300), {
      retryAfter: retryAfterFrom(res.headers),
      code: json?.code || null,
    });
  }
  return { id: json?.messageId || json?.messageIds?.[0] || null };
}

export function readConfig(env) {
  const get = (k) => (typeof env === "function" ? env(k) : env?.[k]) || "";
  const mode = ["disabled", "test", "live"].includes(get("EMAIL_SENDING_MODE")) ? get("EMAIL_SENDING_MODE") : "test";
  return {
    mode,
    apiKey: get("BREVO_API_KEY"),
    from: get("EMAIL_FROM"),
    replyTo: get("EMAIL_REPLY_TO"),
    testTo: get("EMAIL_TEST_TO"),
    appUrl: get("APP_URL"),
    enablePaymentEmails: get("EMAIL_ENABLE_PAYMENT_EMAILS") === "true",
    batchSize: Math.min(Math.max(Number(get("EMAIL_BATCH_SIZE")) || 20, 1), 50),
    perUserPerHour: Math.min(Math.max(Number(get("EMAIL_PER_USER_PER_HOUR")) || 10, 1), 100),
    // Um envio a cada 600 ms: folgado para a Brevo e mantém o lote de 50
    // dentro do tempo de uma Edge Function.
    spacingMs: 600,
  };
}

// Problemas de configuração que impedem QUALQUER envio. Nunca inclui o valor
// da chave na mensagem.
export function configProblems(config) {
  const p = [];
  if (!config.apiKey) p.push("BREVO_API_KEY ausente");
  if (!config.from) p.push("EMAIL_FROM ausente");
  else if (!parseAddress(config.from)) p.push("EMAIL_FROM inválido (use: NEXAR <remetente@verificado.com>)");
  if (config.replyTo && !parseAddress(config.replyTo)) p.push("EMAIL_REPLY_TO inválido");
  if (!config.appUrl) p.push("APP_URL ausente");
  if (config.mode === "test" && !isValidEmail(config.testTo)) p.push("EMAIL_TEST_TO ausente ou inválido (obrigatório no modo test)");
  return p;
}

const sleepPadrao = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Processa um lote da fila.
 *  claim(limit, perUserPerHour) -> [{ id, template, data, dedupe_key, to_email, attempts }]
 *  finish(id, { status: "sent"|"failed"|"retry"|"skipped", error?, providerId?, retryAfterSeconds?, keepAttempt? })
 *  send({ to, subject, html, text, idempotencyKey }) -> { id }
 */
export async function processBatch({ config, claim, finish, send, log = () => {}, sleep = sleepPadrao }) {
  const resumo = { claimed: 0, sent: 0, failed: 0, retried: 0, skipped: 0, stopped: null };

  if (config.mode === "disabled") {
    resumo.stopped = "disabled";
    return resumo;
  }
  const problemas = configProblems(config);
  if (problemas.length) {
    resumo.stopped = "config";
    log("error", "Configuração incompleta; nada enviado", { problemas });
    return resumo;
  }

  const linhas = await claim(config.batchSize, config.perUserPerHour);
  resumo.claimed = linhas.length;
  const vistos = new Set();

  for (let i = 0; i < linhas.length; i++) {
    const row = linhas[i];

    // Depois de 429, cota ou erro de configuração, devolve o resto do lote.
    if (resumo.stopped) {
      const espera = resumo.stopped === "quota" ? QUOTA_RETRY_SECONDS : 60;
      await finish(row.id, { status: "retry", error: `Lote interrompido (${resumo.stopped})`, retryAfterSeconds: espera, keepAttempt: false });
      resumo.retried++;
      continue;
    }

    if (vistos.has(row.dedupe_key)) {
      await finish(row.id, { status: "skipped", error: "Duplicado no mesmo lote" });
      resumo.skipped++;
      continue;
    }
    vistos.add(row.dedupe_key);

    if (!TEMPLATE_NAMES.includes(row.template)) {
      await finish(row.id, { status: "failed", error: `Template desconhecido: ${row.template}` });
      resumo.failed++;
      continue;
    }
    if (PAYMENT_TEMPLATES.includes(row.template) && !config.enablePaymentEmails) {
      await finish(row.id, { status: "skipped", error: "E-mails de pagamento desligados (gateway não implementado)" });
      resumo.skipped++;
      continue;
    }
    if (!isValidEmail(row.to_email)) {
      await finish(row.id, { status: "failed", error: "Destinatário inválido ou ausente" });
      log("warn", "Destinatário inválido", { id: row.id, template: row.template });
      resumo.failed++;
      continue;
    }

    // Só no live: no modo test tudo vai para EMAIL_TEST_TO, e é com as
    // contas de teste que se exercita a fila.
    if (config.mode === "live" && isReservedDomain(row.to_email)) {
      await finish(row.id, { status: "skipped", error: "Domínio reservado (conta de teste)" });
      resumo.skipped++;
      continue;
    }

    // Modo test: TODO e-mail vai para o endereço autorizado, nunca para o
    // destinatário real.
    const destino = config.mode === "test" ? config.testTo : row.to_email.trim();
    let email;
    try {
      email = renderEmail(row.template, row.data || {}, { appUrl: config.appUrl });
    } catch (error) {
      await finish(row.id, { status: "failed", error: `Falha ao montar o template: ${error.message}` });
      resumo.failed++;
      continue;
    }
    const subject = config.mode === "test" ? `[TESTE] ${email.subject}` : email.subject;

    try {
      if (i > 0) await sleep(config.spacingMs);
      // idempotencyKey = id da linha (UUID, igual em toda tentativa).
      const { id } = await send({ to: destino, subject, html: email.html, text: email.text, idempotencyKey: row.id });
      await finish(row.id, { status: "sent", providerId: id });
      log("info", "Enviado", { id: row.id, template: row.template, to: maskEmail(destino) });
      resumo.sent++;
    } catch (error) {
      const kind = error instanceof ProviderError ? error.kind : "transient";
      const tentativa = Number(row.attempts) || 1;
      const msg = maskEmailsInText(error?.message || "erro").slice(0, 300);
      if (kind === "duplicate" && tentativa >= 2) {
        // Houve tentativa anterior de resultado desconhecido (rede/5xx/
        // timeout -- só essas contam em `attempts`): ela chegou à Brevo e só
        // a resposta se perdeu. Conta como enviado, anotado para auditoria.
        await finish(row.id, { status: "sent", error: "Duplicado no provedor: já processado em tentativa anterior" });
        resumo.sent++;
      } else if (kind === "duplicate") {
        // Primeira tentativa "de verdade": as anteriores (429, cota,
        // configuração) foram RECUSADAS e não gastaram tentativa, então o
        // e-mail não saiu. Espera a chave expirar na Brevo e tenta de novo.
        await finish(row.id, { status: "retry", error: "Duplicado no provedor sem envio anterior; aguardando a chave expirar", retryAfterSeconds: DUPLICATE_RETRY_SECONDS, keepAttempt: false });
        resumo.retried++;
      } else if (kind === "permanent") {
        await finish(row.id, { status: "failed", error: msg });
        resumo.failed++;
      } else if (kind === "rate_limited" || kind === "config" || kind === "quota") {
        // Não é culpa deste e-mail: volta para a fila sem gastar tentativa e
        // para o lote.
        const espera = kind === "quota" ? QUOTA_RETRY_SECONDS : error.retryAfter || 60;
        await finish(row.id, { status: "retry", error: msg, retryAfterSeconds: espera, keepAttempt: false });
        resumo.retried++;
        resumo.stopped = kind;
      } else if (tentativa >= MAX_ATTEMPTS) {
        await finish(row.id, { status: "failed", error: `Desistiu após ${tentativa} tentativas: ${msg}` });
        resumo.failed++;
      } else {
        await finish(row.id, { status: "retry", error: msg, retryAfterSeconds: BACKOFF_SECONDS[Math.min(tentativa - 1, BACKOFF_SECONDS.length - 1)] });
        resumo.retried++;
      }
      log("warn", "Falha no envio", { id: row.id, template: row.template, status: error?.status ?? null, code: error?.code ?? null, kind, error: msg.slice(0, 200) });
    }
  }
  return resumo;
}

// Envio de teste: SEMPRE para EMAIL_TEST_TO, nunca para um endereço da
// requisição. Não passa pela fila. Cada teste é um envio novo (UUID novo).
export async function sendTestEmail({ config, send, now = new Date(), randomUUID = () => globalThis.crypto.randomUUID() }) {
  const problemas = configProblems({ ...config, mode: "test" });
  if (problemas.length) return { ok: false, error: problemas.join("; ") };
  const email = renderEmail("test", { sent_at: now.toISOString() }, { appUrl: config.appUrl });
  try {
    const { id } = await send({
      to: config.testTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
      idempotencyKey: randomUUID(),
    });
    return { ok: true, id, to: maskEmail(config.testTo) };
  } catch (error) {
    return { ok: false, status: error?.status ?? null, code: error?.code ?? null, error: maskEmailsInText(error?.message || "erro").slice(0, 300) };
  }
}

// O segredo do worker é a única autenticação da função (deploy sem JWT).
export const MIN_SECRET_LENGTH = 32;

export function secretProblems(secret) {
  const s = String(secret || "");
  if (!s) return "EMAIL_WORKER_SECRET ausente";
  if (s.length < MIN_SECRET_LENGTH) return `EMAIL_WORKER_SECRET curto demais (mínimo ${MIN_SECRET_LENGTH} caracteres)`;
  return null;
}

// Comparação de segredo em tempo constante (o tamanho vaza, o conteúdo não).
export function safeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Decide a porta da Edge Function. Segredo ausente/fraco no servidor é erro
// de configuração (500); header errado ou ausente é 401.
export function authorizeWorker(envSecret, headerValue) {
  const problema = secretProblems(envSecret);
  if (problema) return { ok: false, status: 500, error: "worker_secret_misconfigured", problem: problema };
  if (!safeEqual(headerValue, envSecret)) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}
