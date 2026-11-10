// Integração Asaas -- lógica das Edge Functions billing-checkout e
// asaas-webhook (Resumo.md §232). JavaScript puro com fetch e banco
// injetados: a Edge Function usa de verdade, o Vitest com mocks.
//
// REGRAS
// * A chave da API só existe aqui (secret da Edge Function). Nunca vai para
//   resposta, log ou mensagem de erro.
// * URL base FIXA por ambiente (não configurável) e a chave tem de ser do
//   mesmo ambiente: $aact_hmlg_ = Sandbox, $aact_prod_ = produção.
// * Webhook: token próprio (header asaas-access-token), comparado em tempo
//   constante, >= 32 caracteres e diferente da chave da API.
// * O corpo do webhook NÃO é confiado: o status vem de um GET /payments/{id}
//   feito aqui. Quem decide ativar é o banco (billing_apply_gateway_payment),
//   que ainda confere cobrança, cliente, referência, valor e ambiente.
// * Preço, plano, conta e período vêm do banco (billing_prepare_checkout).
//   Do navegador só se aceita o plan_id escolhido.
//
// Docs (consultadas em 2026-11-03): https://docs.asaas.com/docs/autenticação-1,
// /reference/criar-nova-cobranca, /reference/recuperar-uma-unica-cobranca,
// /reference/listar-clientes, /reference/listar-cobrancas,
// /docs/sobre-os-webhooks, /docs/webhook-para-cobrancas,
// /reference/confirmar-pagamento (só Sandbox).

export const ASAAS_BASE_URLS = Object.freeze({
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
});
const KEY_PREFIX = Object.freeze({ sandbox: "$aact_hmlg_", production: "$aact_prod_" });
export const ASAAS_USER_AGENT = "NEXAR/1.0 (Supabase Edge Functions)";
export const ASAAS_TIMEOUT_MS = 10000;
export const MIN_WEBHOOK_TOKEN_LENGTH = 32;
export const PAID_PLANS = Object.freeze(["profissional", "premium"]);

/**
 * Lê e valida as secrets. `need`: "checkout" (chave) ou "webhook" (chave +
 * token). Falha fechada, sem ecoar valor nenhum.
 * @returns {{ ok: true, config: { environment: string, baseUrl: string, apiKey: string, webhookToken: string|null } }
 *          | { ok: false, reason: string }}
 */
export function readAsaasConfig(env, need = "checkout") {
  const get = (k) => (typeof env?.get === "function" ? env.get(k) : env?.[k]) ?? "";
  const environment = String(get("ASAAS_ENVIRONMENT")).trim();
  if (!Object.hasOwn(ASAAS_BASE_URLS, environment)) return { ok: false, reason: "invalid_environment" };
  const apiKey = String(get("ASAAS_API_KEY")).trim();
  if (!apiKey) return { ok: false, reason: "missing_api_key" };
  if (!apiKey.startsWith(KEY_PREFIX[environment])) return { ok: false, reason: "api_key_environment_mismatch" };
  let webhookToken = null;
  if (need === "webhook") {
    webhookToken = String(get("ASAAS_WEBHOOK_TOKEN"));
    if (webhookToken.length < MIN_WEBHOOK_TOKEN_LENGTH) return { ok: false, reason: "weak_webhook_token" };
    if (webhookToken === apiKey) return { ok: false, reason: "webhook_token_is_api_key" };
  }
  return { ok: true, config: { environment, baseUrl: ASAAS_BASE_URLS[environment], apiKey, webhookToken } };
}

/** Comparação em tempo constante (não para no primeiro byte diferente). */
export function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function verifyWebhookToken(received, expected) {
  if (typeof expected !== "string" || expected.length < MIN_WEBHOOK_TOKEN_LENGTH) return false;
  if (typeof received !== "string" || received.length === 0) return false;
  return timingSafeEqual(received, expected);
}

/** Centavos inteiros -> valor do Asaas (number com 2 casas). */
export function centsToValue(cents) {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("invalid_amount");
  return Number((cents / 100).toFixed(2));
}

/** CPF/CNPJ para o Asaas: só letras/dígitos, maiúsculas (CNPJ 2026 é alfanumérico). */
export function normalizeCpfCnpj(v) {
  const s = String(v ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return s.length === 11 || s.length === 14 ? s : null;
}

/** Monta o cliente do Asaas a partir do perfil gravado (não do navegador). */
export function buildCustomerPayload(profile, userId, email) {
  const cpfCnpj = normalizeCpfCnpj(profile?.cnpj);
  if (!cpfCnpj) return { ok: false, reason: "cpf_cnpj_required" };
  const name = String(profile?.company_name || profile?.full_name || "").trim().slice(0, 200);
  if (!name) return { ok: false, reason: "name_required" };
  const payload = { name, cpfCnpj, externalReference: userId };
  if (email) payload.email = String(email).slice(0, 200);
  return { ok: true, payload };
}

/** Erro do Asaas sem ecoar corpo nem chave: só status e códigos. */
export class AsaasError extends Error {
  constructor(status, codes = []) {
    super(`asaas_http_${status}${codes.length ? ":" + codes.join(",") : ""}`);
    this.status = status;
    this.codes = codes;
  }
}

export function createAsaasClient({ config, fetchImpl = fetch, timeoutMs = ASAAS_TIMEOUT_MS }) {
  async function request(method, path, body) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(config.baseUrl + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": ASAAS_USER_AGENT,
          access_token: config.apiKey,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      throw new AsaasError(0, ["unavailable"]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const codes = Array.isArray(data?.errors)
        ? data.errors.map((e) => String(e?.code ?? "")).filter(Boolean).slice(0, 5)
        : [];
      throw new AsaasError(res.status, codes);
    }
    return data;
  }
  const q = (v) => encodeURIComponent(String(v));
  return {
    async findCustomerByExternalReference(ref) {
      const d = await request("GET", `/customers?externalReference=${q(ref)}&limit=10`);
      return (d?.data ?? []).find((c) => c?.externalReference === ref && !c?.deleted) ?? null;
    },
    createCustomer: (payload) => request("POST", "/customers", payload),
    async findPaymentByExternalReference(ref) {
      const d = await request("GET", `/payments?externalReference=${q(ref)}&limit=10`);
      return (d?.data ?? []).find((p) => p?.externalReference === ref && !p?.deleted) ?? null;
    },
    createPayment: (payload) => request("POST", "/payments", payload),
    getPayment: (id) => request("GET", `/payments/${q(id)}`),
    // DELETE /v3/payments/{id}: o Asaas recusa remover cobrança já paga.
    deletePayment: (id) => request("DELETE", `/payments/${q(id)}`),
    // Pagar dentro do NEXAR (§237): QR do Pix e linha digitável do boleto.
    // Valem para billingType UNDEFINED quando a forma está disponível na conta.
    getPixQrCode: (id) => request("GET", `/payments/${q(id)}/pixQrCode`),
    getIdentificationField: (id) => request("GET", `/payments/${q(id)}/identificationField`),
    // Cartão digitado no NEXAR (§240): paga a MESMA cobrança já criada.
    payWithCreditCard: (id, payload) => request("POST", `/payments/${q(id)}/payWithCreditCard`, payload),
  };
}

/**
 * Instruções de pagamento para mostrar DENTRO do NEXAR (§237). Melhor
 * esforço: se o Asaas não devolver uma forma (indisponível na conta, fora do
 * ar), ela vem null e a tela oferece só as outras -- nunca bloqueia o
 * checkout. Cartão NÃO entra aqui: é digitado na página segura do Asaas
 * (invoiceUrl), para os dados do cartão nunca passarem pelo NEXAR.
 */
export async function paymentInstructions(asaas, gatewayPaymentId, payment = null) {
  const [pix, linha, pay] = await Promise.allSettled([
    (async () => asaas.getPixQrCode(gatewayPaymentId))(),
    (async () => asaas.getIdentificationField(gatewayPaymentId))(),
    (async () => payment ?? asaas.getPayment(gatewayPaymentId))(),
  ]);
  const p = pix.status === "fulfilled" ? pix.value : null;
  const b = linha.status === "fulfilled" ? linha.value : null;
  payment = pay.status === "fulfilled" ? pay.value : null;
  return {
    pix: p?.payload && p?.encodedImage
      ? { qrImage: `data:image/png;base64,${p.encodedImage}`, copyPaste: String(p.payload), expiresAt: p.expirationDate ?? null }
      : null,
    boleto: b?.identificationField
      ? { line: String(b.identificationField), pdfUrl: payment?.bankSlipUrl ?? null }
      : null,
  };
}

/** Mesma classificação de billing_apply_gateway_payment (SQL). */
export function classifyAsaasPayment(p) {
  const s = String(p?.status ?? "");
  if (p?.deleted === true) return "deleted";
  if (["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"].includes(s)) return "paid";
  if (["REFUNDED", "REFUND_REQUESTED", "REFUND_IN_PROGRESS", "CHARGEBACK_REQUESTED",
       "CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL"].includes(s)) return "reversed";
  // Cartão em análise de risco: pode virar pago -- não se cancela.
  if (s === "AWAITING_RISK_ANALYSIS") return "analysis";
  return "open";
}

/** Argumentos de billing_apply_gateway_payment a partir da cobrança RE-CONSULTADA. */
export function applyArgs(environment, payment) {
  return {
    p_environment: environment,
    p_gateway_payment_id: String(payment?.id ?? ""),
    p_gateway_status: String(payment?.status ?? ""),
    p_value: Number(payment?.value),
    p_customer_id: payment?.customer ?? null,
    p_external_reference: payment?.externalReference ?? null,
    p_deleted: payment?.deleted === true,
  };
}

/**
 * Erro do Asaas que não melhora com nova tentativa: 4xx, exceto 429 (limite)
 * e 401/403 -- esses são a NOSSA chave/permissão errada; tratar como
 * permanente descartaria eventos válidos até alguém corrigir a secret.
 */
export const isPermanentAsaasError = (e) => {
  const st = Number(e?.status ?? 0);
  return st >= 400 && st < 500 && ![401, 403, 429].includes(st);
};

/** Webhook: só o que precisamos, com tipos conferidos. */
export function parseWebhookEvent(body) {
  if (!body || typeof body !== "object") return { ok: false, reason: "invalid_body" };
  const eventId = typeof body.id === "string" ? body.id.trim() : "";
  const eventType = typeof body.event === "string" ? body.event.trim() : "";
  if (!eventId || eventId.length > 200 || !eventType) return { ok: false, reason: "invalid_event" };
  const paymentId = eventType.startsWith("PAYMENT_") && typeof body.payment?.id === "string" ? body.payment.id : null;
  return { ok: true, eventId, eventType, paymentId };
}

// Códigos do banco -> HTTP + mensagem para a tela.
const CHECKOUT_ERRORS = {
  INVALID_PLAN: [400, "Plano inválido."],
  BILLING_DISABLED: [503, "A contratação online ainda não está disponível."],
  ENVIRONMENT_MISMATCH: [503, "A contratação online ainda não está disponível."],
  ACCOUNT_NOT_FOUND: [404, "Conta não encontrada."],
  NOT_A_SUPPLIER: [403, "Só contas de fornecedor contratam planos."],
  ALREADY_ON_PAID_PLAN: [409, "Você já tem um plano pago vigente. Troca entre planos pagos ainda não está disponível."],
  PENDING_CHARGE_EXISTS: [409, "Você já tem uma cobrança em aberto de outro plano. Pague ou aguarde o vencimento dela."],
  CHARGE_IN_PROGRESS: [409, "Sua cobrança está sendo gerada. Tente de novo em alguns segundos."],
  PREVIOUS_CHARGE_PAID: [409, "Identificamos o pagamento da sua cobrança anterior. Seu plano será atualizado em instantes."],
  PREVIOUS_CHARGE_IN_ANALYSIS: [409, "Sua cobrança anterior está em análise no Asaas. Aguarde o resultado antes de gerar outra."],
  PREVIOUS_CHARGE_UNAPPLIED: [409, "Recebemos o pagamento da sua cobrança anterior fora do período dela. Ele está em análise pela nossa equipe; o plano não foi ativado."],
  PREVIOUS_CHARGE_UNCONFIRMED: [409, "Não conseguimos confirmar a situação da sua cobrança anterior. Ela está em análise; tente de novo mais tarde."],
  PAYMENT_UNDER_REVIEW: [409, "Há um pagamento anterior em análise na sua conta. Você poderá contratar de novo assim que ele for resolvido."],
  cpf_cnpj_required: [422, "Cadastre o CNPJ da empresa em Conta para gerar a cobrança."],
  CARD_INVALID: [422, "Confira os dados do cartão e do titular."],
  CARD_DECLINED: [402, "Cartão recusado. Confira os dados ou use outro cartão."],
  CARD_NOT_AVAILABLE: [409, "Esta cobrança não pode mais ser paga com cartão. Atualize a página."],
  name_required: [422, "Cadastre o nome da empresa em Conta para gerar a cobrança."],
};
/** Códigos que o checkout pode devolver (o front tem um texto para cada). */
export const CHECKOUT_ERROR_CODES = Object.freeze(Object.keys(CHECKOUT_ERRORS));
export function checkoutErrorFor(code) {
  const [status, message] = CHECKOUT_ERRORS[code] ?? [500, "Não foi possível gerar a cobrança. Tente de novo."];
  return { status, body: { error: CHECKOUT_ERRORS[code] ? code : "checkout_failed", message } };
}
const dbCode = (error) => (/([A-Z][A-Z_]{3,})/.exec(String(error?.message ?? "")) ?? [])[1] ?? "UNKNOWN";
const review = (db, reason, extra = {}) =>
  db.rpc("billing_review_add", {
    p_reason: reason, p_payment_id: extra.paymentId ?? null, p_gateway_payment_id: extra.gatewayPaymentId ?? null,
    p_event_id: extra.eventId ?? null, p_details: extra.details ?? null, p_created_by: extra.createdBy ?? null,
  });

// Cobrança que o Asaas não achou (404) ou recusou: de quem é? Externa
// (nada liga ao NEXAR) -> ignora sem análise. Nossa ou ambígua -> análise
// CHARGE_STATE_UNKNOWN (bloqueia checkout da conta; a reconciliação tenta
// de novo e resolve sozinha se o estado ficar conhecido).
async function handleUnknownState({ db, config, gatewayPaymentId, hint = {}, eventId = null, status }) {
  const own = await db.rpc("billing_charge_ownership", {
    p_environment: config.environment, p_gateway_payment_id: gatewayPaymentId,
    p_external_reference: hint.externalReference ?? null, p_customer_id: hint.customer ?? null,
  });
  if (own.error) throw new Error(`ownership_failed:${dbCode(own.error)}`);
  const o = Array.isArray(own.data) ? own.data[0] : own.data;
  if (!o || o.owner === "external") return { external: true };
  await review(db, status === 404 ? "CHARGE_STATE_UNKNOWN" : `REFETCH_FAILED_${status}`, {
    paymentId: o.payment_id ?? null, gatewayPaymentId, eventId, createdBy: o.created_by ?? null,
    details: { owner: o.owner, status },
  });
  return { external: false };
}

async function ensureCustomer({ user, config, db, asaas }) {
  let customerId = (await db.rpc("billing_customer_get", { p_uid: user.id, p_environment: config.environment })).data;
  if (customerId) return { customerId };
  const found = await asaas.findCustomerByExternalReference(user.id);
  if (found) {
    customerId = found.id;
  } else {
    const built = buildCustomerPayload(await db.profile(user.id), user.id, user.email);
    if (!built.ok) return { error: checkoutErrorFor(built.reason) };
    customerId = (await asaas.createCustomer(built.payload)).id;
  }
  const saved = await db.rpc("billing_customer_save", { p_uid: user.id, p_environment: config.environment, p_customer_id: customerId });
  if (saved.error) return { error: checkoutErrorFor(dbCode(saved.error)) };
  return { customerId: saved.data };
}

// Só roda com a reserva da linha (ação 'create'): no máximo uma criação
// por cobrança local. Procura por externalReference antes de criar (o
// Asaas não documenta chave de idempotência).
async function createCharge({ charge, planId, user, config, db, asaas }) {
  const cust = await ensureCustomer({ user, config, db, asaas });
  if (cust.error) return cust.error;
  const customerId = cust.customerId;

  let created = false;
  let payment = await asaas.findPaymentByExternalReference(charge.payment_id);
  if (!payment) {
    payment = await asaas.createPayment({
      customer: customerId,
      billingType: "UNDEFINED",
      value: centsToValue(charge.amount_cents),
      dueDate: charge.due_date,          // do banco (billing_quote)
      description: `NEXAR - plano ${planId}`,
      externalReference: charge.payment_id,
    });
    created = true;
  }
  if (payment.customer !== customerId || Math.round(Number(payment.value) * 100) !== charge.amount_cents) {
    await review(db, "CHARGE_MISMATCH", { paymentId: charge.payment_id, gatewayPaymentId: payment.id });
    return checkoutErrorFor("charge_mismatch");
  }
  const att = await db.rpc("billing_attach_gateway_charge", {
    p_payment_id: charge.payment_id, p_gateway_payment_id: payment.id,
    p_gateway_customer_id: customerId, p_invoice_url: payment.invoiceUrl ?? null,
  });
  if (att.error) {
    // A cobrança existe no Asaas mas não ficou ligada: não pode sobrar uma
    // fatura pagável "órfã". Só remove a que ESTA requisição criou e só
    // quando o banco RECUSOU de forma definitiva -- num erro de transporte a
    // ligação pode ter sido gravada, e remover deixaria a linha presa a uma
    // fatura morta. Nos outros casos: análise manual, cobrança mantida.
    const code = dbCode(att.error);
    const definitivo = code === "PAYMENT_NOT_ATTACHABLE" || code === "CUSTOMER_MISMATCH";
    let removida = false;
    if (created && definitivo) {
      try { removida = (await asaas.deletePayment(payment.id))?.deleted === true; } catch { /* fica para a análise */ }
    }
    await review(db, "ATTACH_FAILED", { paymentId: charge.payment_id, gatewayPaymentId: payment.id,
      details: { code, deleted_here: removida } });
    return checkoutErrorFor(code);
  }
  return { status: 200, body: await checkoutBody({ charge, gatewayPaymentId: payment.id,
    invoiceUrl: payment.invoiceUrl ?? null, reused: false, payment, asaas }) };
}

// Resposta de sucesso do checkout. paymentId é o id LOCAL (payments.id): a
// tela acompanha o status por ele (RLS deixa o dono ler a própria linha).
async function checkoutBody({ charge, gatewayPaymentId, invoiceUrl, reused, payment, asaas }) {
  const ins = gatewayPaymentId ? await paymentInstructions(asaas, gatewayPaymentId, payment)
    : { pix: null, boleto: null };
  return { invoiceUrl, reused, paymentId: charge.payment_id, gatewayPaymentId: gatewayPaymentId ?? null, amountCents: charge.amount_cents ?? null,
    dueDate: charge.due_date ?? null, pix: ins.pix, boleto: ins.boleto };
}

// Pendente VENCIDA: o estado real vem do Asaas antes de qualquer coisa.
// Devolve null quando a antiga ficou encerrada (pode nascer outra) ou a
// resposta a dar (paga, em análise...). Nada é criado aqui.
async function settleStale({ charge, config, db, asaas }) {
  let gid = charge.gateway_payment_id;
  if (!gid) {
    // Nunca ligada: chegou a nascer no Asaas?
    const found = await asaas.findPaymentByExternalReference(charge.payment_id);
    if (!found) {
      const v = await db.rpc("billing_void_unattached", { p_payment_id: charge.payment_id });
      if (v.error) return checkoutErrorFor(dbCode(v.error) === "CLAIM_ACTIVE" ? "CHARGE_IN_PROGRESS" : dbCode(v.error));
      return null;
    }
    const att = await db.rpc("billing_attach_gateway_charge", {
      p_payment_id: charge.payment_id, p_gateway_payment_id: found.id,
      p_gateway_customer_id: found.customer, p_invoice_url: found.invoiceUrl ?? null,
    });
    if (att.error) {
      await review(db, "STALE_ATTACH_FAILED", { paymentId: charge.payment_id, gatewayPaymentId: found.id,
        details: { code: dbCode(att.error) } });
      return checkoutErrorFor(dbCode(att.error));
    }
    gid = found.id;
  }

  let pay;
  try {
    pay = await asaas.getPayment(gid);
  } catch (e) {
    // 404 sozinho NÃO prova que a cobrança foi removida e não pode ser
    // paga (§234). Nada é anulado: vai para análise -- que bloqueia novo
    // checkout da conta -- e a reconciliação tenta de novo.
    if (Number(e?.status) !== 404) throw e;
    await review(db, "CHARGE_STATE_UNKNOWN", { paymentId: charge.payment_id, gatewayPaymentId: gid,
      details: { stage: "checkout_refetch", status: 404 } });
    return checkoutErrorFor("PREVIOUS_CHARGE_UNCONFIRMED");
  }
  let kind = classifyAsaasPayment(pay);
  if (kind === "open") {
    // Em aberto/vencida: remove no Asaas e CONFERE de novo. Se foi paga no
    // meio do caminho o Asaas recusa a remoção e a re-consulta mostra "pago".
    let removed = false;
    try {
      removed = (await asaas.deletePayment(gid))?.deleted === true;
    } catch (e) {
      if (!isPermanentAsaasError(e)) throw e;
    }
    try {
      pay = await asaas.getPayment(gid);
    } catch (e) {
      if (!(removed && Number(e?.status) === 404)) throw e;
      pay = { ...pay, deleted: true };
    }
    kind = classifyAsaasPayment(pay);
  }
  if (kind === "analysis") return checkoutErrorFor("PREVIOUS_CHARGE_IN_ANALYSIS");
  if (kind === "open") {
    await review(db, "STALE_NOT_REMOVED", { paymentId: charge.payment_id, gatewayPaymentId: gid, details: { status: pay?.status } });
    return checkoutErrorFor("CHARGE_IN_PROGRESS");
  }

  const a = await db.rpc("billing_apply_gateway_payment", applyArgs(config.environment, pay));
  if (a.error) throw new Error(`apply_failed:${dbCode(a.error)}`);
  const result = a.data?.result;
  if (result === "rejected") return checkoutErrorFor("charge_mismatch");
  if (kind === "paid") {
    // A mensagem segue o que o BANCO fez, não o status do Asaas: pago fora
    // do período (LATE_PAYMENT) é aprovado SEM ativar -- dizer "seu plano
    // será atualizado" seria falso.
    if (result === "activated" || result === "already_applied") return checkoutErrorFor("PREVIOUS_CHARGE_PAID");
    if (result === "approved_unapplied") return checkoutErrorFor("PREVIOUS_CHARGE_UNAPPLIED");
    return checkoutErrorFor("UNKNOWN");
  }
  return null;                                   // removida/estornada: encerrada
}

/**
 * Checkout. `db.rpc(nome, args)` -> { data, error } (service_role);
 * `db.profile(uid)` -> { company_name, full_name, cnpj } | null.
 * O banco decide a ação (billing_prepare_checkout): reuse | create | wait |
 * check_stale. Erros do Asaas sobem (a Edge Function responde 502) -- e
 * nenhuma cobrança nova nasce sem a anterior estar comprovadamente encerrada.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function handleCheckout({ user, body, config, db, asaas }) {
  const planId = typeof body?.plan_id === "string" ? body.plan_id : "";
  if (!PAID_PLANS.includes(planId)) return checkoutErrorFor("INVALID_PLAN");

  for (let round = 0; round < 3; round++) {
    const prep = await db.rpc("billing_prepare_checkout", { p_uid: user.id, p_plan_id: planId, p_environment: config.environment });
    if (prep.error) return checkoutErrorFor(dbCode(prep.error));
    const charge = prep.data;
    switch (charge?.action) {
      case "reuse":
        return { status: 200, body: await checkoutBody({ charge, gatewayPaymentId: charge.gateway_payment_id,
          invoiceUrl: charge.invoice_url, reused: true, payment: null, asaas }) };
      case "wait":
        return checkoutErrorFor("CHARGE_IN_PROGRESS");
      case "create":
        return createCharge({ charge, planId, user, config, db, asaas });
      case "check_stale": {
        const out = await settleStale({ charge, config, db, asaas });
        if (out) return out;
        continue;                                // antiga encerrada: prepara de novo
      }
      default:
        return checkoutErrorFor("UNKNOWN");
    }
  }
  return checkoutErrorFor("CHARGE_IN_PROGRESS");
}

/**
 * Webhook. 401 sem token (nada gravado); 400 corpo inválido (nada gravado);
 * 200 quando o evento foi gravado e tratado -- inclusive divergência ou erro
 * permanente do Asaas, que vão para a análise manual (reenviar não muda
 * nada, e 15 falhas seguidas pausam a fila inteira); 5xx em falha
 * transitória: o evento fica 'failed', o Asaas reenvia e a reconciliação
 * também o pega.
 * @returns {Promise<{ status: number, body: object, log?: object }>}
 */
export async function handleWebhook({ token, body, config, db, asaas }) {
  if (!verifyWebhookToken(token, config.webhookToken)) return { status: 401, body: { error: "unauthorized" } };
  const ev = parseWebhookEvent(body);
  if (!ev.ok) return { status: 400, body: { error: ev.reason } };

  const begin = await db.rpc("billing_webhook_begin", { p_event_id: ev.eventId, p_event_type: ev.eventType, p_payload: body });
  if (begin.error) return { status: 500, body: { error: "store_failed" }, log: { stage: "begin", code: dbCode(begin.error) } };
  if (begin.data === "duplicate") return { status: 200, body: { result: "duplicate" } };

  const finish = (status, error = null) =>
    db.rpc("billing_webhook_finish", { p_event_id: ev.eventId, p_status: status, p_error: error });

  if (!ev.paymentId) {
    await finish("ignored", "not_a_payment_event");
    return { status: 200, body: { result: "ignored" } };
  }

  let payment;
  try {
    payment = await asaas.getPayment(ev.paymentId);   // RE-CONSULTA: o corpo não vale
  } catch (e) {
    if (!isPermanentAsaasError(e)) {
      await finish("failed", String(e?.message ?? "asaas_error"));
      return { status: 502, body: { error: "gateway_unavailable" }, log: { stage: "refetch", error: String(e?.message) } };
    }
    const st = Number(e?.status);
    // O corpo do evento só serve de PISTA para saber de quem é (o token já
    // provou que veio do Asaas); nunca para decidir pagamento.
    let u;
    try {
      u = await handleUnknownState({ db, config, gatewayPaymentId: ev.paymentId, eventId: ev.eventId, status: st,
        hint: { externalReference: body?.payment?.externalReference, customer: body?.payment?.customer } });
    } catch (err) {
      await finish("failed", String(err?.message ?? "ownership"));
      return { status: 500, body: { error: "store_failed" }, log: { stage: "ownership", error: String(err?.message) } };
    }
    await finish("ignored", u.external ? "external_charge" : `refetch_${st}`);
    return { status: 200, body: { result: "ignored" }, log: { stage: "refetch", status: st, external: u.external } };
  }

  const applied = await db.rpc("billing_apply_gateway_payment", applyArgs(config.environment, payment));
  if (applied.error) {
    await finish("failed", dbCode(applied.error));
    return { status: 500, body: { error: "apply_failed" }, log: { stage: "apply", code: dbCode(applied.error) } };
  }
  const result = applied.data?.result ?? "?";
  const reason = applied.data?.reason ?? null;
  await finish(result === "rejected" ? "ignored" : "processed",
    result === "rejected" ? (reason === "EXTERNAL_CHARGE" ? "external_charge" : `rejected:${reason}`) : null);
  return { status: 200, body: { result }, log: { result, reason } };
}

export const RECONCILE_MAX_BATCH = 200;

/** O segredo do agendador é forte e EXCLUSIVO (não reaproveita outro). */
export function reconcileSecretProblem(expectedSecret, config) {
  if (typeof expectedSecret !== "string" || expectedSecret.length < MIN_WEBHOOK_TOKEN_LENGTH) return "weak_reconcile_secret";
  if (expectedSecret === config?.apiKey || expectedSecret === config?.webhookToken) return "reconcile_secret_reused";
  return null;
}

/**
 * Reconciliação (Edge Function billing-reconcile): não depende de webhook.
 * Re-consulta no Asaas o que billing_reconcile_candidates aponta (eventos
 * parados, pendentes sem notícia, estado desconhecido) e aplica pelo mesmo
 * billing_apply_gateway_payment -- idempotente. Uma execução por vez
 * (billing_reconcile_begin; outra concorrente sai como skipped), lote
 * limitado, resultado gravado em billing_reconcile_runs.
 */
export async function handleReconcile({ secret, expectedSecret, config, db, asaas, limit = 50, source = "manual",
                                        budgetMs = 40000, nowFn = () => Date.now() }) {
  const inicio = nowFn();
  const problema = reconcileSecretProblem(expectedSecret, config);
  if (problema) return { status: 503, body: { error: "not_configured" }, log: { reason: problema } };
  if (!verifyWebhookToken(secret, expectedSecret)) return { status: 401, body: { error: "unauthorized" } };
  const lote = Math.min(Math.max(Number.isInteger(limit) ? limit : 50, 1), RECONCILE_MAX_BATCH);

  const begin = await db.rpc("billing_reconcile_begin", { p_source: source, p_lease_seconds: 600 });
  if (begin.error) return { status: 500, body: { error: "begin_failed" } };
  if (!begin.data) return { status: 200, body: { skipped: true, reason: "reconcile_in_progress" } };
  const runId = begin.data;

  const total = { checked: 0, processed: 0, failed: 0, ignored: 0, review: 0 };
  const erros = [];
  try {
    const c = await db.rpc("billing_reconcile_candidates", { p_limit: lote });
    if (c.error) throw new Error(`candidates_failed:${dbCode(c.error)}`);

    const porCobranca = new Map();
    for (const row of c.data ?? []) {
      const gid = row?.gateway_payment_id;
      if (!gid) continue;
      // Prazo: para antes do limite de tempo da Edge Function. O que sobrar
      // fica para a próxima rodada (idempotente: nada se perde).
      if (!porCobranca.has(gid) && nowFn() - inicio > budgetMs) {
        total.deferred = (total.deferred ?? 0) + 1;
        continue;
      }
      if (!porCobranca.has(gid)) {
        total.checked++;
        let r;
        try {
          const pay = await asaas.getPayment(gid);
          const a = await db.rpc("billing_apply_gateway_payment", applyArgs(config.environment, pay));
          r = a.error ? { status: "failed", error: dbCode(a.error) }
            : a.data?.result === "rejected" ? { status: "ignored", error: `rejected:${a.data?.reason}` }
            : { status: "processed", error: null };
        } catch (e) {
          if (isPermanentAsaasError(e)) {
            const u = await handleUnknownState({ db, config, gatewayPaymentId: gid, status: Number(e?.status),
              eventId: row.kind === "event" ? row.event_id : null,
              hint: { externalReference: row.hint_external_reference ?? null, customer: row.hint_customer ?? null } });
            r = { status: "ignored", error: u.external ? "external_charge" : `refetch_${Number(e?.status)}` };
            if (!u.external) total.review++;
          } else {
            r = { status: "failed", error: String(e?.message ?? "asaas_error") };
          }
        }
        porCobranca.set(gid, r);
        total[r.status]++;
        if (r.status === "failed" && erros.length < 20) erros.push({ gid, error: r.error });
      }
      if (row.kind === "event") {
        const r = porCobranca.get(gid);
        await db.rpc("billing_webhook_finish", { p_event_id: row.event_id, p_status: r.status, p_error: r.error });
      }
    }
    await db.rpc("billing_reconcile_finish", { p_run_id: runId, p_status: "done", p_stats: { ...total, erros }, p_error: null });
    return { status: 200, body: { run_id: runId, ...total } };
  } catch (e) {
    await db.rpc("billing_reconcile_finish", { p_run_id: runId, p_status: "failed", p_stats: { ...total, erros },
      p_error: String(e?.message ?? "erro") });
    throw e;
  }
}


/**
 * Cartão digitado na tela do NEXAR (§240). Os dados vão direto para o Asaas
 * e NÃO são gravados nem registrados em log em lugar nenhum -- nem em
 * mensagem de erro (AsaasError só leva status e códigos). Paga a mesma
 * cobrança do checkout (externalReference = payments.id), e a ativação é a
 * de sempre: billing_apply_gateway_payment com a cobrança RE-CONSULTADA.
 */
export function parseCardInput(card, holder, email) {
  const d = (v) => String(v ?? "").replace(/\D/g, "");
  const number = d(card?.number);
  const month = d(card?.expiryMonth).padStart(2, "0");
  let year = d(card?.expiryYear);
  if (year.length === 2) year = "20" + year;
  const ccv = d(card?.ccv);
  const holderName = String(card?.holderName ?? "").trim();
  const cpfCnpj = d(holder?.cpfCnpj);
  const postalCode = d(holder?.postalCode);
  const phone = d(holder?.phone);
  const addressNumber = String(holder?.addressNumber ?? "").trim();
  const name = String(holder?.name ?? holderName).trim();
  const ok = number.length >= 13 && number.length <= 19 && luhn(number)
    && Number(month) >= 1 && Number(month) <= 12 && year.length === 4
    && (ccv.length === 3 || ccv.length === 4) && holderName.length >= 3
    && (cpfCnpj.length === 11 || cpfCnpj.length === 14) && postalCode.length === 8
    && phone.length >= 10 && phone.length <= 11 && addressNumber.length >= 1 && addressNumber.length <= 10
    && name.length >= 3;
  if (!ok) return { ok: false };
  return { ok: true, payload: {
    creditCard: { holderName, number, expiryMonth: month, expiryYear: year, ccv },
    creditCardHolderInfo: { name, email: email ?? "", cpfCnpj, postalCode, addressNumber, phone, mobilePhone: phone },
  } };
}

function luhn(n) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) {
    let x = Number(n[n.length - 1 - i]);
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

export async function handleCardPayment({ user, body, config, db, asaas, remoteIp }) {
  const parsed = parseCardInput(body?.card, body?.holder, user.email);
  if (!parsed.ok) return checkoutErrorFor("CARD_INVALID");
  const out = await handleCheckout({ user, body: { plan_id: body?.plan_id }, config, db, asaas });
  if (out.status !== 200) return out;
  const gid = out.body.gatewayPaymentId;
  if (!gid) return checkoutErrorFor("CHARGE_IN_PROGRESS");

  try {
    await asaas.payWithCreditCard(gid, { ...parsed.payload, ...(remoteIp ? { remoteIp } : {}) });
  } catch (e) {
    const st = Number(e?.status);
    if (st !== 400 && st !== 402 && st !== 422) throw e;   // transitório: 502 na função
    // Recusa, ou cobrança que não aceita mais cartão: a re-consulta decide.
    let pay = null;
    try { pay = await asaas.getPayment(gid); } catch { /* segue como recusa */ }
    if (classifyAsaasPayment(pay) !== "paid") {
      const aberta = !pay || pay.status === "PENDING" || pay.status === "OVERDUE";
      return checkoutErrorFor(aberta ? "CARD_DECLINED" : "CARD_NOT_AVAILABLE");
    }
  }
  const pay = await asaas.getPayment(gid);         // RE-CONSULTA: a resposta do POST não vale
  const a = await db.rpc("billing_apply_gateway_payment", applyArgs(config.environment, pay));
  if (a.error) throw new Error(`apply_failed:${dbCode(a.error)}`);
  return { status: 200, body: { paymentId: out.body.paymentId, result: a.data?.result ?? null,
    gatewayStatus: String(pay?.status ?? "") } };
}
