// Lógica das Edge Functions billing-checkout / asaas-webhook (§232).
// TESTES COM MOCKS: nenhum acesso ao Asaas nem ao banco.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ASAAS_BASE_URLS, readAsaasConfig, verifyWebhookToken, createAsaasClient, parseWebhookEvent,
  handleCheckout, handleWebhook, handleReconcile, centsToValue, classifyAsaasPayment, normalizeCpfCnpj, buildCustomerPayload,
  AsaasError, handleCardPayment, parseCardInput,
} from "../../../Backend/supabase/functions/_shared/asaas.js";
import { PLAN_PRICES } from "../lib/plans";

const SANDBOX_KEY = "$aact_hmlg_000000000000000000000000chave_de_teste";
const TOKEN = "t".repeat(40);
const RSECRET = "r".repeat(40);
const cfg = { environment: "sandbox", baseUrl: ASAAS_BASE_URLS.sandbox, apiKey: SANDBOX_KEY, webhookToken: TOKEN };

describe("configuração -- falha fechada", () => {
  const env = (o) => ({ ASAAS_ENVIRONMENT: "sandbox", ASAAS_API_KEY: SANDBOX_KEY, ASAAS_WEBHOOK_TOKEN: TOKEN, ...o });
  it("aceita sandbox com chave do sandbox e URL fixa", () => {
    const r = readAsaasConfig(env({}), "webhook");
    expect(r.ok).toBe(true);
    expect(r.config.baseUrl).toBe("https://api-sandbox.asaas.com/v3");
  });
  it("recusa ambiente desconhecido, chave de outro ambiente e token fraco/igual à chave", () => {
    expect(readAsaasConfig(env({ ASAAS_ENVIRONMENT: "homolog" })).reason).toBe("invalid_environment");
    expect(readAsaasConfig(env({ ASAAS_API_KEY: "$aact_prod_xyz" })).reason).toBe("api_key_environment_mismatch");
    expect(readAsaasConfig(env({ ASAAS_ENVIRONMENT: "production" })).reason).toBe("api_key_environment_mismatch");
    expect(readAsaasConfig(env({ ASAAS_API_KEY: "" })).reason).toBe("missing_api_key");
    expect(readAsaasConfig(env({ ASAAS_WEBHOOK_TOKEN: "curto" }), "webhook").reason).toBe("weak_webhook_token");
    const k = "$aact_hmlg_" + "x".repeat(40);
    expect(readAsaasConfig(env({ ASAAS_API_KEY: k, ASAAS_WEBHOOK_TOKEN: k }), "webhook").reason).toBe("webhook_token_is_api_key");
  });
  it("nenhuma mensagem de motivo contém a chave", () => {
    const r = readAsaasConfig(env({ ASAAS_ENVIRONMENT: "production" }));
    expect(JSON.stringify(r)).not.toContain(SANDBOX_KEY);
  });
});

describe("token do webhook", () => {
  it("só o token exato passa", () => {
    expect(verifyWebhookToken(TOKEN, TOKEN)).toBe(true);
    expect(verifyWebhookToken(TOKEN + "x", TOKEN)).toBe(false);
    expect(verifyWebhookToken("", TOKEN)).toBe(false);
    expect(verifyWebhookToken(null, TOKEN)).toBe(false);
    expect(verifyWebhookToken(SANDBOX_KEY, TOKEN)).toBe(false);
    expect(verifyWebhookToken("abc", "abc")).toBe(false); // segredo fraco nunca vale
  });
});

describe("cliente HTTP do Asaas", () => {
  it("manda access_token e User-Agent, na URL fixa do ambiente", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ id: "pay_1" }) }));
    await createAsaasClient({ config: cfg, fetchImpl }).getPayment("pay_1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/payments/pay_1");
    expect(init.headers.access_token).toBe(SANDBOX_KEY);
    expect(init.headers["User-Agent"]).toMatch(/NEXAR/);
    expect(init.headers.Authorization).toBeUndefined();
  });
  it("erro do Asaas não vaza chave nem corpo, só status e códigos", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ errors: [{ code: "invalid_value", description: `chave ${SANDBOX_KEY} cpf 123` }] }),
    }));
    const e = await createAsaasClient({ config: cfg, fetchImpl }).createPayment({}).catch((x) => x);
    expect(e.message).toBe("asaas_http_400:invalid_value");
    expect(e.message).not.toContain(SANDBOX_KEY);
    expect(e.message).not.toContain("123");
  });
  it("rede fora do ar vira erro genérico", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`connect ${SANDBOX_KEY}`); });
    const e = await createAsaasClient({ config: cfg, fetchImpl }).getPayment("x").catch((x) => x);
    expect(e.message).toBe("asaas_http_0:unavailable");
  });
});

describe("valores e dados", () => {
  it("centavos -> valor exato; zero/fração recusados", () => {
    expect(centsToValue(4900)).toBe(49);
    expect(centsToValue(9990)).toBe(99.9);
    expect(() => centsToValue(0)).toThrow();
    expect(() => centsToValue(49.5)).toThrow();
  });
  it("classificação do status igual à do banco", () => {
    expect(classifyAsaasPayment({ status: "RECEIVED" })).toBe("paid");
    expect(classifyAsaasPayment({ status: "CONFIRMED" })).toBe("paid");
    expect(classifyAsaasPayment({ status: "OVERDUE" })).toBe("open");
    expect(classifyAsaasPayment({ status: "PENDING", deleted: true })).toBe("deleted");
    expect(classifyAsaasPayment({ status: "REFUNDED" })).toBe("reversed");
    expect(classifyAsaasPayment({ status: "AWAITING_RISK_ANALYSIS" })).toBe("analysis");
  });
  it("CPF/CNPJ: numérico e alfanumérico 2026; inválido = exige cadastro", () => {
    expect(normalizeCpfCnpj("12.345.678/0001-95")).toBe("12345678000195");
    expect(normalizeCpfCnpj("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    expect(normalizeCpfCnpj("123")).toBeNull();
    expect(buildCustomerPayload({ company_name: "X" }, "u1").reason).toBe("cpf_cnpj_required");
    expect(buildCustomerPayload({ company_name: "X", cnpj: "12345678000195" }, "u1", "a@b.c").payload)
      .toEqual({ name: "X", cpfCnpj: "12345678000195", externalReference: "u1", email: "a@b.c" });
  });
  it("webhook: precisa de id e evento; só PAYMENT_* tem cobrança", () => {
    expect(parseWebhookEvent(null).ok).toBe(false);
    expect(parseWebhookEvent({ event: "PAYMENT_RECEIVED" }).ok).toBe(false);
    expect(parseWebhookEvent({ id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: "pay_1" } }).paymentId).toBe("pay_1");
    expect(parseWebhookEvent({ id: "evt_2", event: "TRANSFER_DONE", payment: { id: "p" } }).paymentId).toBeNull();
  });
});

// ---------------------------------------------------------------- checkout
function fakeDb(over = {}) {
  const calls = [];
  const answers = {
    billing_prepare_checkout: { data: { action: "create", payment_id: "loc-1", amount_cents: 9900, covers_until: "2026-12-10T03:00:00Z", due_date: "2026-11-06" } },
    billing_void_unattached: { data: "voided" },
    billing_review_add: { data: null },
    billing_reconcile_candidates: { data: [] },
    billing_reconcile_begin: { data: "run-1" },
    billing_reconcile_finish: { data: null },
    billing_charge_ownership: { data: [{ owner: "nexar", created_by: "u-1", payment_id: "loc-1" }] },
    billing_customer_get: { data: null },
    billing_customer_save: { data: "cus_1" },
    billing_attach_gateway_charge: { data: null },
    billing_webhook_begin: { data: "process" },
    billing_webhook_finish: { data: null },
    billing_apply_gateway_payment: { data: { result: "activated" } },
    ...over,
  };
  return {
    calls,
    // Resposta fixa, ou lista consumida em ordem (várias chamadas ao mesmo RPC).
    rpc: vi.fn(async (name, args) => {
      calls.push([name, args]);
      const a = answers[name];
      return (Array.isArray(a) ? (a.length > 1 ? a.shift() : a[0]) : a) ?? { data: null };
    }),
    profile: vi.fn(async () => ({ company_name: "Empresa", cnpj: "12345678000195" })),
  };
}
function fakeAsaas(over = {}) {
  return {
    findCustomerByExternalReference: vi.fn(async () => null),
    createCustomer: vi.fn(async () => ({ id: "cus_1" })),
    findPaymentByExternalReference: vi.fn(async () => null),
    createPayment: vi.fn(async (p) => ({ id: "pay_9", customer: p.customer, value: p.value, invoiceUrl: "https://sandbox.asaas.com/i/9" })),
    getPayment: vi.fn(async () => ({ id: "pay_9", status: "RECEIVED", value: 99, customer: "cus_1", externalReference: "loc-1" })),
    deletePayment: vi.fn(async () => ({ deleted: true })),
    ...over,
  };
}
const user = { id: "u-1", email: "f@nexar.test" };

describe("checkout -- o navegador só escolhe o plano", () => {
  it("valor, referência e período vêm do banco, não do corpo", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas();
    const out = await handleCheckout({
      user, config: cfg, db, asaas,
      body: { plan_id: "premium", amount_cents: 1, value: 0.01, user_id: "outro", paid: true, environment: "production" },
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ invoiceUrl: "https://sandbox.asaas.com/i/9", reused: false, paymentId: "loc-1" });
    expect(db.calls[0]).toEqual(["billing_prepare_checkout", { p_uid: "u-1", p_plan_id: "premium", p_environment: "sandbox" }]);
    expect(asaas.createPayment.mock.calls[0][0]).toMatchObject({
      customer: "cus_1", billingType: "UNDEFINED", value: 99, externalReference: "loc-1", dueDate: "2026-11-06",
    });
    expect(db.calls.find(([n]) => n === "billing_attach_gateway_charge")[1]).toMatchObject({ p_payment_id: "loc-1", p_gateway_payment_id: "pay_9" });
  });
  it("plano inválido ou Básico não chega ao banco", async () => {
    for (const plan_id of ["basico", "ouro", "", null, "Premium"]) {
      const db = fakeDb();
      const out = await handleCheckout({ user, config: cfg, db, asaas: fakeAsaas(), body: { plan_id } });
      expect(out.status).toBe(400);
      expect(db.rpc).not.toHaveBeenCalled();
    }
  });
  it("criar a cobrança NÃO ativa nada (só o webhook ativa)", async () => {
    const db = fakeDb();
    await handleCheckout({ user, config: cfg, db, asaas: fakeAsaas(), body: { plan_id: "premium" } });
    expect(db.calls.map(([n]) => n)).not.toContain("billing_apply_gateway_payment");
  });
  it("clique repetido reaproveita a fatura sem chamar o Asaas", async () => {
    const db = fakeDb({ billing_prepare_checkout: { data: { action: "reuse", payment_id: "loc-1", invoice_url: "https://x/i/1" } } });
    const asaas = fakeAsaas();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body).toMatchObject({ invoiceUrl: "https://x/i/1", reused: true, paymentId: "loc-1", pix: null, boleto: null });
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("pagar no NEXAR: devolve QR do Pix e linha do boleto (§237)", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({
      getPixQrCode: vi.fn(async () => ({ encodedImage: "QUJD", payload: "000201pix", expirationDate: "2026-11-10 23:59:59" })),
      getIdentificationField: vi.fn(async () => ({ identificationField: "23790.00000 1", nossoNumero: "1", barCode: "2379" })),
      createPayment: vi.fn(async (p) => ({ id: "pay_9", customer: p.customer, value: p.value, invoiceUrl: "u", bankSlipUrl: "https://b/1.pdf" })),
    });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.pix).toEqual({ qrImage: "data:image/png;base64,QUJD", copyPaste: "000201pix", expiresAt: "2026-11-10 23:59:59" });
    expect(out.body.boleto).toEqual({ line: "23790.00000 1", pdfUrl: "https://b/1.pdf" });
    expect(asaas.getPixQrCode).toHaveBeenCalledWith("pay_9");
  });
  it("Pix/boleto indisponíveis não derrubam o checkout: só o link da fatura", async () => {
    const asaas = fakeAsaas({
      getPixQrCode: vi.fn(async () => { throw Object.assign(new Error("x"), { status: 400 }); }),
      getIdentificationField: vi.fn(async () => { throw Object.assign(new Error("x"), { status: 500 }); }),
    });
    const out = await handleCheckout({ user, config: cfg, db: fakeDb(), asaas, body: { plan_id: "premium" } });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ invoiceUrl: "https://sandbox.asaas.com/i/9", pix: null, boleto: null });
  });
  it("retentativa: acha a cobrança já criada por externalReference em vez de duplicar", async () => {
    const asaas = fakeAsaas({ findPaymentByExternalReference: vi.fn(async () => ({ id: "pay_old", customer: "cus_1", value: 99, invoiceUrl: "u" })) });
    await handleCheckout({ user, config: cfg, db: fakeDb(), asaas, body: { plan_id: "premium" } });
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("cobrança achada com valor/cliente divergente não é ligada", async () => {
    const asaas = fakeAsaas({ findPaymentByExternalReference: vi.fn(async () => ({ id: "p", customer: "cus_X", value: 99 })) });
    const db = fakeDb();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.status).toBe(500);
    expect(db.calls.map(([n]) => n)).not.toContain("billing_attach_gateway_charge");
  });
  it("sem CNPJ no perfil: pede cadastro, não cria cliente", async () => {
    const db = fakeDb();
    db.profile = vi.fn(async () => ({ company_name: "X", cnpj: null }));
    const asaas = fakeAsaas();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "profissional" } });
    expect(out.status).toBe(422);
    expect(asaas.createCustomer).not.toHaveBeenCalled();
  });
  it("erros do banco viram resposta clara (cobrança desligada, já tem plano pago)", async () => {
    for (const [code, status] of [["BILLING_DISABLED", 503], ["ALREADY_ON_PAID_PLAN", 409], ["NOT_A_SUPPLIER", 403]]) {
      const db = fakeDb({ billing_prepare_checkout: { error: { message: code } } });
      expect((await handleCheckout({ user, config: cfg, db, asaas: fakeAsaas(), body: { plan_id: "premium" } })).status).toBe(status);
    }
  });
});

describe("webhook", () => {
  const body = { id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: "pay_9", status: "RECEIVED", value: 99 } };
  it("sem token válido: 401 e nada é gravado nem consultado", async () => {
    for (const token of [null, "", "errado", SANDBOX_KEY]) {
      const db = fakeDb();
      const asaas = fakeAsaas();
      const out = await handleWebhook({ token, body, config: cfg, db, asaas });
      expect(out.status).toBe(401);
      expect(db.rpc).not.toHaveBeenCalled();
      expect(asaas.getPayment).not.toHaveBeenCalled();
    }
  });
  it("re-consulta o Asaas: o status do corpo não vale", async () => {
    const db = fakeDb({ billing_apply_gateway_payment: { data: { result: "pending" } } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => ({ id: "pay_9", status: "PENDING", value: 99, customer: "cus_1", externalReference: "loc-1" })) });
    const out = await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas });
    expect(asaas.getPayment).toHaveBeenCalledWith("pay_9");
    expect(db.calls.find(([n]) => n === "billing_apply_gateway_payment")[1]).toMatchObject({
      p_environment: "sandbox", p_gateway_status: "PENDING", p_value: 99, p_external_reference: "loc-1",
    });
    expect(out.body.result).toBe("pending");
  });
  it("evento repetido: 200 sem consultar nem aplicar de novo", async () => {
    const db = fakeDb({ billing_webhook_begin: { data: "duplicate" } });
    const asaas = fakeAsaas();
    const out = await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas });
    expect(out).toMatchObject({ status: 200, body: { result: "duplicate" } });
    expect(asaas.getPayment).not.toHaveBeenCalled();
  });
  it("Asaas fora do ar: 5xx (o Asaas reenvia) e o evento fica 'failed'", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new Error("asaas_http_0:unavailable"); }) });
    const out = await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas });
    expect(out.status).toBe(502);
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1].p_status).toBe("failed");
    expect(db.calls.map(([n]) => n)).not.toContain("billing_apply_gateway_payment");
  });
  it("re-consulta com erro permanente (404): 200 + 'ignored', sem aplicar -- não trava a fila", async () => {
    const { AsaasError } = await import("../../../Backend/supabase/functions/_shared/asaas.js");
    const db = fakeDb();
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(404, ["not_found"]); }) });
    const out = await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas });
    expect(out.status).toBe(200);
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1]).toMatchObject({ p_status: "ignored", p_error: "refetch_404" });
    expect(db.calls.map(([n]) => n)).not.toContain("billing_apply_gateway_payment");
  });
  it("re-consulta com 503/429: continua 502 para reenvio", async () => {
    const { AsaasError } = await import("../../../Backend/supabase/functions/_shared/asaas.js");
    for (const st of [503, 429]) {
      const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(st); }) });
      expect((await handleWebhook({ token: TOKEN, body, config: cfg, db: fakeDb(), asaas })).status).toBe(502);
    }
  });
  it("divergência recusada pelo banco: 200 (reenviar não muda) e evento 'ignored'", async () => {
    const db = fakeDb({ billing_apply_gateway_payment: { data: { result: "rejected", reason: "AMOUNT_MISMATCH" } } });
    const out = await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas: fakeAsaas() });
    expect(out.status).toBe(200);
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1]).toMatchObject({ p_status: "ignored", p_error: "rejected:AMOUNT_MISMATCH" });
  });
  it("evento que não é de cobrança: ignorado sem consultar", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas();
    await handleWebhook({ token: TOKEN, body: { id: "e", event: "TRANSFER_DONE" }, config: cfg, db, asaas });
    expect(asaas.getPayment).not.toHaveBeenCalled();
  });
});

describe("preço espelhado no banco", () => {
  it("plan_price_cents (asaas-billing.sql) = PLAN_PRICES (plans.js)", () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), "../Backend/supabase/asaas-billing.sql"), "utf8");
    const corpo = sql.slice(sql.indexOf("function public.plan_price_cents"));
    for (const [plano, reais] of Object.entries(PLAN_PRICES)) {
      const m = new RegExp(`when '${plano}' then (\\d+)`).exec(corpo);
      expect(Number(m?.[1]), plano).toBe(reais * 100);
    }
  });
});

// ------------------------------------------- §233: pendente vencida etc.
const stale = (extra = {}) => ({ data: { action: "check_stale", payment_id: "old-1", gateway_payment_id: "pay_old", plan_id: "premium", amount_cents: 9900, ...extra } });
const oldCharge = (status, extra = {}) => ({ id: "pay_old", status, value: 99, customer: "cus_1", externalReference: "old-1", ...extra });
const novaCriacao = { data: { action: "create", payment_id: "new-1", amount_cents: 9900, due_date: "2026-11-07" } };
const nomes = (db) => db.calls.map(([n]) => n);

describe("checkout -- cobrança pendente vencida (§233)", () => {
  it("em aberto no Asaas: remove, CONFERE de novo, anula e só então cria a nova", async () => {
    const db = fakeDb({ billing_prepare_checkout: [stale(), novaCriacao], billing_apply_gateway_payment: { data: { result: "voided" } } });
    const asaas = fakeAsaas({
      getPayment: vi.fn().mockResolvedValueOnce(oldCharge("OVERDUE")).mockResolvedValueOnce(oldCharge("OVERDUE", { deleted: true })),
    });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.status).toBe(200);
    expect(asaas.deletePayment).toHaveBeenCalledWith("pay_old");
    expect(asaas.getPayment).toHaveBeenCalledTimes(2);
    expect(db.calls.find(([n]) => n === "billing_apply_gateway_payment")[1]).toMatchObject({ p_gateway_payment_id: "pay_old", p_deleted: true });
    // anula a antiga ANTES de preparar/criar a nova
    expect(nomes(db).indexOf("billing_apply_gateway_payment")).toBeLessThan(nomes(db).lastIndexOf("billing_prepare_checkout"));
    expect(asaas.createPayment.mock.calls[0][0]).toMatchObject({ externalReference: "new-1", dueDate: "2026-11-07" });
  });
  it("já cancelada no Asaas: só anula e cria a nova (sem tentar remover)", async () => {
    const db = fakeDb({ billing_prepare_checkout: [stale(), novaCriacao], billing_apply_gateway_payment: { data: { result: "voided" } } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => oldCharge("PENDING", { deleted: true })) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.status).toBe(200);
    expect(asaas.deletePayment).not.toHaveBeenCalled();
  });
  it("PAGA durante a substituição: o Asaas recusa remover, a re-consulta mostra pago -> aplica, NÃO cria outra", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({
      getPayment: vi.fn().mockResolvedValueOnce(oldCharge("PENDING")).mockResolvedValueOnce(oldCharge("RECEIVED")),
      deletePayment: vi.fn(async () => { throw new AsaasError(400, ["invalid_action"]); }),
    });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out).toMatchObject({ status: 409, body: { error: "PREVIOUS_CHARGE_PAID" } });
    expect(db.calls.find(([n]) => n === "billing_apply_gateway_payment")[1].p_gateway_status).toBe("RECEIVED");
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("já paga na 1ª consulta: aplica e não remove nem cria", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => oldCharge("CONFIRMED")) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.error).toBe("PREVIOUS_CHARGE_PAID");
    expect(asaas.deletePayment).not.toHaveBeenCalled();
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("cartão em análise de risco: não cancela, pede para aguardar", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => oldCharge("AWAITING_RISK_ANALYSIS")) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.error).toBe("PREVIOUS_CHARGE_IN_ANALYSIS");
    expect(asaas.deletePayment).not.toHaveBeenCalled();
    expect(nomes(db)).not.toContain("billing_apply_gateway_payment");
  });
  it("Asaas fora do ar na conferência: erro sobe (502), nada anulado nem criado", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(0, ["unavailable"]); }) });
    await expect(handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } })).rejects.toThrow(/unavailable/);
    expect(nomes(db)).not.toContain("billing_apply_gateway_payment");
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("Asaas cai DEPOIS de remover: não anula às cegas", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({
      getPayment: vi.fn().mockResolvedValueOnce(oldCharge("OVERDUE")).mockRejectedValueOnce(new AsaasError(503)),
    });
    await expect(handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } })).rejects.toThrow();
    expect(nomes(db)).not.toContain("billing_apply_gateway_payment");
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("vencida que nunca chegou ao Asaas: procura por referência; sem achar, anula sem apagar", async () => {
    const db = fakeDb({ billing_prepare_checkout: [stale({ gateway_payment_id: null }), novaCriacao] });
    const asaas = fakeAsaas();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(asaas.findPaymentByExternalReference.mock.calls[0][0]).toBe("old-1");
    expect(nomes(db)).toContain("billing_void_unattached");
    expect(out.status).toBe(200);
  });
  it("dois checkouts ao mesmo tempo: o 2º recebe 'wait' e não chama o Asaas", async () => {
    const db = fakeDb({ billing_prepare_checkout: { data: { action: "wait", payment_id: "loc-1" } } });
    const asaas = fakeAsaas();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out).toMatchObject({ status: 409, body: { error: "CHARGE_IN_PROGRESS" } });
    expect(asaas.createPayment).not.toHaveBeenCalled();
    expect(asaas.findPaymentByExternalReference).not.toHaveBeenCalled();
  });
  it("cobrança criada mas não ligada: remove a que criou e manda para análise (sem órfã pagável)", async () => {
    const db = fakeDb({ billing_attach_gateway_charge: { error: { message: "PAYMENT_NOT_ATTACHABLE" } } });
    const asaas = fakeAsaas();
    await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(asaas.deletePayment).toHaveBeenCalledWith("pay_9");
    expect(db.calls.find(([n]) => n === "billing_review_add")[1].p_reason).toBe("ATTACH_FAILED");
  });
});

describe("webhook e reconciliação -- análise manual e recuperação (§233)", () => {
  const body = { id: "evt_1", event: "PAYMENT_RECEIVED", payment: { id: "pay_9" } };
  it("erro permanente na re-consulta vai para a análise manual", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(404); }) });
    await handleWebhook({ token: TOKEN, body, config: cfg, db, asaas });
    expect(db.calls.find(([n]) => n === "billing_review_add")[1]).toMatchObject({ p_reason: "CHARGE_STATE_UNKNOWN", p_event_id: "evt_1", p_payment_id: "loc-1" });
  });
  it("fora de ordem: evento antigo chegando depois do pago só re-consulta, e o banco ignora", async () => {
    const db = fakeDb({ billing_apply_gateway_payment: { data: { result: "ignored", reason: "OUT_OF_ORDER" } } });
    const out = await handleWebhook({ token: TOKEN, body: { id: "evt_old", event: "PAYMENT_CREATED", payment: { id: "pay_9" } }, config: cfg, db, asaas: fakeAsaas() });
    expect(out).toMatchObject({ status: 200, body: { result: "ignored" } });
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1].p_status).toBe("processed");
  });
  it("reconciliação: segredo obrigatório", async () => {
    const out = await handleReconcile({ secret: "x", expectedSecret: RSECRET, config: cfg, db: fakeDb(), asaas: fakeAsaas() });
    expect(out.status).toBe(401);
  });
  it("reconciliação: re-consulta cada cobrança uma vez e fecha os eventos parados", async () => {
    const db = fakeDb({ billing_reconcile_candidates: { data: [
      { kind: "event", event_id: "evt_a", gateway_payment_id: "pay_9" },
      { kind: "event", event_id: "evt_b", gateway_payment_id: "pay_9" },
      { kind: "payment", event_id: null, gateway_payment_id: "pay_7" },
    ] } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async (id) => ({ id, status: "RECEIVED", value: 99, customer: "cus_1", externalReference: "loc-1" })) });
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas });
    expect(out.body).toEqual({ run_id: "run-1", checked: 2, processed: 2, failed: 0, ignored: 0, review: 0 });
    expect(asaas.getPayment).toHaveBeenCalledTimes(2);
    expect(db.calls.filter(([n]) => n === "billing_webhook_finish").map(([, a]) => [a.p_event_id, a.p_status]))
      .toEqual([["evt_a", "processed"], ["evt_b", "processed"]]);
  });
  it("reconciliação com Asaas fora: evento continua 'failed' (tenta de novo depois)", async () => {
    const db = fakeDb({ billing_reconcile_candidates: { data: [{ kind: "event", event_id: "evt_a", gateway_payment_id: "pay_9" }] } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(0, ["unavailable"]); }) });
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas });
    expect(out.body.failed).toBe(1);
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1].p_status).toBe("failed");
    expect(nomes(db)).not.toContain("billing_apply_gateway_payment");
  });
});

describe("checkout -- a resposta segue o que o banco fez (§233)", () => {
  it("vencida pela virada do ciclo e paga depois: aprovada SEM ativar -> não diz 'plano atualizado'", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale(),
      billing_apply_gateway_payment: { data: { result: "approved_unapplied", reason: "LATE_PAYMENT" } } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => oldCharge("RECEIVED")) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.error).toBe("PREVIOUS_CHARGE_UNAPPLIED");
    expect(out.body.message).not.toMatch(/será atualizado/);
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("paga e o banco ignorou (ex.: já estornada): resposta genérica, nada criado", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale(),
      billing_apply_gateway_payment: { data: { result: "ignored", reason: "ALREADY_REVERSED" } } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => oldCharge("RECEIVED")) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.error).toBe("checkout_failed");
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("erro de transporte ao ligar: NÃO remove a cobrança (a ligação pode ter gravado); vai para análise", async () => {
    const db = fakeDb({ billing_attach_gateway_charge: { error: { message: "fetch failed" } } });
    const asaas = fakeAsaas();
    await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(asaas.deletePayment).not.toHaveBeenCalled();
    expect(db.calls.find(([n]) => n === "billing_review_add")[1].p_reason).toBe("ATTACH_FAILED");
  });
});

// ------------------------------------------------------------------ §234
describe("§234 -- cobranças de fora, estado desconhecido e reconciliação", () => {
  const body404 = { id: "evt_x", event: "PAYMENT_RECEIVED", payment: { id: "pay_ext", externalReference: "pedido-loja-77", customer: "cus_loja" } };
  const g404 = () => fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(404); }) });

  it("evento de cobrança EXTERNA ao NEXAR (404, nada liga a nós): ignorado sem análise, com registro", async () => {
    const db = fakeDb({ billing_charge_ownership: { data: [{ owner: "external", created_by: null, payment_id: null }] } });
    const out = await handleWebhook({ token: TOKEN, body: body404, config: cfg, db, asaas: g404() });
    expect(out.status).toBe(200);
    expect(nomes(db)).not.toContain("billing_review_add");
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1]).toMatchObject({ p_status: "ignored", p_error: "external_charge" });
    // a pista do corpo foi usada só para saber de quem é
    expect(db.calls.find(([n]) => n === "billing_charge_ownership")[1]).toMatchObject({
      p_gateway_payment_id: "pay_ext", p_external_reference: "pedido-loja-77", p_customer_id: "cus_loja" });
  });
  it("propriedade AMBÍGUA (cliente nosso, cobrança desconhecida): não descarta -- análise ligada à conta", async () => {
    const db = fakeDb({ billing_charge_ownership: { data: [{ owner: "nexar_customer", created_by: "u-9", payment_id: null }] } });
    await handleWebhook({ token: TOKEN, body: body404, config: cfg, db, asaas: g404() });
    expect(db.calls.find(([n]) => n === "billing_review_add")[1]).toMatchObject({ p_reason: "CHARGE_STATE_UNKNOWN", p_created_by: "u-9" });
  });
  it("cobrança externa que o Asaas ACHOU: o banco recusa como EXTERNAL_CHARGE e o evento fica de auditoria", async () => {
    const db = fakeDb({ billing_apply_gateway_payment: { data: { result: "rejected", reason: "EXTERNAL_CHARGE" } } });
    const out = await handleWebhook({ token: TOKEN, body: { id: "evt_e", event: "PAYMENT_RECEIVED", payment: { id: "pay_9" } }, config: cfg, db, asaas: fakeAsaas() });
    expect(out.status).toBe(200);
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1]).toMatchObject({ p_status: "ignored", p_error: "external_charge" });
  });
  it("401/403 do Asaas (nossa chave errada) NÃO descarta o evento: 502 para reenvio", async () => {
    for (const st of [401, 403]) {
      const db = fakeDb();
      const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(st); }) });
      const out = await handleWebhook({ token: TOKEN, body: body404, config: cfg, db, asaas });
      expect(out.status).toBe(502);
      expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1].p_status).toBe("failed");
    }
  });
  it("checkout: 404 ao reconsultar a vencida NÃO anula -- análise + aviso, nada criado", async () => {
    const db = fakeDb({ billing_prepare_checkout: stale() });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(404); }) });
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out.body.error).toBe("PREVIOUS_CHARGE_UNCONFIRMED");
    expect(db.calls.find(([n]) => n === "billing_review_add")[1]).toMatchObject({ p_reason: "CHARGE_STATE_UNKNOWN", p_payment_id: "old-1" });
    expect(nomes(db)).not.toContain("billing_apply_gateway_payment");
    expect(asaas.deletePayment).not.toHaveBeenCalled();
    expect(asaas.createPayment).not.toHaveBeenCalled();
  });
  it("checkout bloqueado por análise aberta: PAYMENT_UNDER_REVIEW, nada no Asaas", async () => {
    const db = fakeDb({ billing_prepare_checkout: { error: { message: "PAYMENT_UNDER_REVIEW" } } });
    const asaas = fakeAsaas();
    const out = await handleCheckout({ user, config: cfg, db, asaas, body: { plan_id: "premium" } });
    expect(out).toMatchObject({ status: 409, body: { error: "PAYMENT_UNDER_REVIEW" } });
    expect(asaas.findPaymentByExternalReference).not.toHaveBeenCalled();
  });
  it("reconciliação: segredo fraco ou REPETIDO (= token do webhook / chave) é recusado", async () => {
    for (const s of ["curto", TOKEN, SANDBOX_KEY]) {
      const out = await handleReconcile({ secret: s, expectedSecret: s, config: cfg, db: fakeDb(), asaas: fakeAsaas() });
      expect(out.status).toBe(503);
    }
  });
  it("reconciliação concorrente: a 2ª sai como skipped sem consultar nada", async () => {
    const db = fakeDb({ billing_reconcile_begin: { data: null } });
    const asaas = fakeAsaas();
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas });
    expect(out.body).toEqual({ skipped: true, reason: "reconcile_in_progress" });
    expect(nomes(db)).not.toContain("billing_reconcile_candidates");
    expect(asaas.getPayment).not.toHaveBeenCalled();
  });
  it("reconciliação: lote limitado, resultado gravado; 404 de cobrança nossa vira análise", async () => {
    const db = fakeDb({ billing_reconcile_candidates: { data: [{ kind: "payment", event_id: null, gateway_payment_id: "pay_9" }] } });
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas: g404(), limit: 9999 });
    expect(db.calls.find(([n]) => n === "billing_reconcile_candidates")[1].p_limit).toBe(200);
    expect(out.body).toMatchObject({ checked: 1, ignored: 1, review: 1 });
    expect(db.calls.find(([n]) => n === "billing_reconcile_finish")[1]).toMatchObject({ p_run_id: "run-1", p_status: "done" });
  });
  it("reconciliação: falha no meio grava a execução como 'failed'", async () => {
    const db = fakeDb({ billing_reconcile_candidates: { error: { message: "boom" } } });
    await expect(handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas: fakeAsaas() })).rejects.toThrow();
    expect(db.calls.find(([n]) => n === "billing_reconcile_finish")[1].p_status).toBe("failed");
  });
});

describe("§234 -- reconciliação: pistas de propriedade e prazo", () => {
  it("evento parado de cobrança ÓRFÃ + 404: a pista do evento gravado evita descartar como externa", async () => {
    const db = fakeDb({
      billing_reconcile_candidates: { data: [{ kind: "event", event_id: "evt_o", gateway_payment_id: "pay_orfa",
        hint_external_reference: "loc-1", hint_customer: "cus_1" }] },
      billing_charge_ownership: { data: [{ owner: "nexar_orphan", created_by: "u-1", payment_id: "loc-1" }] },
    });
    const asaas = fakeAsaas({ getPayment: vi.fn(async () => { throw new AsaasError(404); }) });
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas });
    expect(db.calls.find(([n]) => n === "billing_charge_ownership")[1]).toMatchObject({
      p_gateway_payment_id: "pay_orfa", p_external_reference: "loc-1", p_customer_id: "cus_1" });
    expect(db.calls.find(([n]) => n === "billing_review_add")[1]).toMatchObject({ p_reason: "CHARGE_STATE_UNKNOWN", p_event_id: "evt_o" });
    expect(db.calls.find(([n]) => n === "billing_webhook_finish")[1].p_error).toBe("refetch_404");
    expect(out.body.review).toBe(1);
  });
  it("prazo estourado: para de consultar, o resto fica para a próxima rodada e a execução fecha 'done'", async () => {
    let t = 0;
    const db = fakeDb({ billing_reconcile_candidates: { data: [
      { kind: "payment", gateway_payment_id: "pay_a" }, { kind: "payment", gateway_payment_id: "pay_b" },
      { kind: "event", event_id: "evt_c", gateway_payment_id: "pay_c" }] } });
    const asaas = fakeAsaas({ getPayment: vi.fn(async (id) => { t += 50000; return { id, status: "PENDING", value: 99, customer: "cus_1", externalReference: "loc-1" }; }) });
    const out = await handleReconcile({ secret: RSECRET, expectedSecret: RSECRET, config: cfg, db, asaas, nowFn: () => t });
    expect(asaas.getPayment).toHaveBeenCalledTimes(1);
    expect(out.body).toMatchObject({ checked: 1, deferred: 2 });
    // evento adiado NÃO é marcado (continua candidato)
    expect(db.calls.filter(([n]) => n === "billing_webhook_finish")).toHaveLength(0);
    expect(db.calls.find(([n]) => n === "billing_reconcile_finish")[1].p_status).toBe("done");
  });
});

describe("chaves do Supabase nas Edge Functions (legadas x novas, §236)", async () => {
  const { supabaseKeys } = await import("../../../Backend/supabase/functions/_shared/supabaseKeys.js");
  it("projeto antigo: usa anon/service_role", () => {
    const k = supabaseKeys({ SUPABASE_URL: "u", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "srv",
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "pub" }), SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sec" }) });
    expect(k).toEqual({ url: "u", publicKey: "anon", serviceKey: "srv" });
  });
  it("projeto novo: usa a default de publishable/secret", () => {
    const k = supabaseKeys({ SUPABASE_URL: "u", SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_x" }),
      SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_y", outra: "z" }) });
    expect(k).toEqual({ url: "u", publicKey: "sb_publishable_x", serviceKey: "sb_secret_y" });
  });
  it("JSON inválido ou ausente: null (a função responde 503, não quebra)", () => {
    expect(supabaseKeys({ SUPABASE_SECRET_KEYS: "{lixo" }).serviceKey).toBeNull();
    expect(supabaseKeys({}).publicKey).toBeNull();
    expect(supabaseKeys({ get: (n) => (n === "SUPABASE_URL" ? "x" : undefined) }).url).toBe("x");
  });
});

describe("cartão digitado no NEXAR (§240)", () => {
  const card = { holderName: "MARIA TESTE", number: "5162 3062 1937 8829", expiryMonth: "5", expiryYear: "30", ccv: "318" };
  const holder = { name: "Maria Teste", cpfCnpj: "249.715.637-92", postalCode: "89223-005", addressNumber: "277", phone: "(47) 99999-0000" };
  const paid = { id: "pay_9", status: "CONFIRMED", value: 99, customer: "cus_1", externalReference: "loc-1" };

  it("valida os dados antes de qualquer chamada", () => {
    expect(parseCardInput(card, holder, "f@x").ok).toBe(true);
    expect(parseCardInput({ ...card, number: "5162306219378828" }, holder, "f@x").ok).toBe(false); // Luhn
    expect(parseCardInput({ ...card, expiryMonth: "13" }, holder, "f@x").ok).toBe(false);
    expect(parseCardInput(card, { ...holder, cpfCnpj: "123" }, "f@x").ok).toBe(false);
    const ok = parseCardInput(card, holder, "f@x").payload;
    expect(ok.creditCard).toEqual({ holderName: "MARIA TESTE", number: "5162306219378829", expiryMonth: "05", expiryYear: "2030", ccv: "318" });
    expect(ok.creditCardHolderInfo).toMatchObject({ cpfCnpj: "24971563792", postalCode: "89223005", phone: "47999990000", email: "f@x" });
  });
  it("dado inválido: nada chega ao banco nem ao Asaas", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({ payWithCreditCard: vi.fn() });
    const out = await handleCardPayment({ user, config: cfg, db, asaas, body: { plan_id: "premium", card: { ...card, ccv: "" }, holder } });
    expect(out.body.error).toBe("CARD_INVALID");
    expect(db.rpc).not.toHaveBeenCalled();
    expect(asaas.payWithCreditCard).not.toHaveBeenCalled();
  });
  it("aprovado: paga a mesma cobrança e ativa pela re-consulta", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({ payWithCreditCard: vi.fn(async () => ({ status: "CONFIRMED" })), getPayment: vi.fn(async () => paid) });
    const out = await handleCardPayment({ user, config: cfg, db, asaas, remoteIp: "1.2.3.4", body: { plan_id: "premium", card, holder } });
    expect(out).toEqual({ status: 200, body: { paymentId: "loc-1", result: "activated", gatewayStatus: "CONFIRMED" } });
    expect(asaas.payWithCreditCard.mock.calls[0][0]).toBe("pay_9");
    expect(asaas.payWithCreditCard.mock.calls[0][1].remoteIp).toBe("1.2.3.4");
    expect(db.calls.find(([n]) => n === "billing_apply_gateway_payment")[1]).toMatchObject({ p_gateway_payment_id: "pay_9", p_gateway_status: "CONFIRMED" });
  });
  it("recusado: CARD_DECLINED e nada é aplicado", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({
      payWithCreditCard: vi.fn(async () => { throw new AsaasError(400, ["invalid_creditCard"]); }),
      getPayment: vi.fn(async () => ({ ...paid, status: "PENDING" })),
    });
    const out = await handleCardPayment({ user, config: cfg, db, asaas, body: { plan_id: "premium", card, holder } });
    expect(out.status).toBe(402);
    expect(out.body.error).toBe("CARD_DECLINED");
    expect(db.calls.map(([n]) => n)).not.toContain("billing_apply_gateway_payment");
  });
  it("Asaas fora do ar: o erro sobe (502), sem aplicar", async () => {
    const db = fakeDb();
    const asaas = fakeAsaas({ payWithCreditCard: vi.fn(async () => { throw new AsaasError(0, ["unavailable"]); }) });
    await expect(handleCardPayment({ user, config: cfg, db, asaas, body: { plan_id: "premium", card, holder } })).rejects.toThrow();
    expect(db.calls.map(([n]) => n)).not.toContain("billing_apply_gateway_payment");
  });
  it("o erro do cartão não carrega dado do cartão", () => {
    const e = new AsaasError(400, ["invalid_creditCard"]);
    expect(JSON.stringify({ m: e.message, s: e.status })).not.toMatch(/5162|318/);
  });
});
