import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  renderEmail, TEMPLATE_NAMES, escapeHtml, appLink,
} from "../../../Backend/supabase/functions/_shared/emailTemplates.js";
import {
  processBatch, sendViaBrevo, sendTestEmail, readConfig, configProblems, BREVO_URL,
  ProviderError, isValidEmail, maskEmail, safeEqual, MAX_ATTEMPTS, QUOTA_RETRY_SECONDS, DUPLICATE_RETRY_SECONDS,
  isReservedDomain, secretProblems, MIN_SECRET_LENGTH, authorizeWorker, parseAddress, maskEmailsInText,
} from "../../../Backend/supabase/functions/_shared/emailWorker.js";

// Nada aqui sai para a rede: Brevo e banco são mocks.

const APP = "http://localhost:5173";

const CONFIG = readConfig({
  BREVO_API_KEY: "xkeysib-teste-nao-real",
  EMAIL_FROM: "NEXAR <nao-responda@nexar.test>",
  APP_URL: APP,
  EMAIL_SENDING_MODE: "live",
});

function fila(rows) {
  const finish = vi.fn(async () => {});
  const claim = vi.fn(async () => rows);
  return { claim, finish };
}

const linha = (extra = {}) => ({
  id: "r1", template: "quote_request", dedupe_key: "contact_request:1",
  to_email: "dono@empresa.com", attempts: 1,
  data: { supplier_name: "Embalagens Sul", sender_name: "Ana", message_excerpt: "Preciso de 500 caixas." },
  ...extra,
});

const semEspera = () => Promise.resolve();

describe("templates", () => {
  it("todos têm assunto, HTML e texto, com a identidade do NEXAR", () => {
    for (const nome of TEMPLATE_NAMES) {
      const e = renderEmail(nome, { full_name: "Ana", title: "Aviso importante", body: "Texto" }, { appUrl: APP });
      expect(e.subject.length).toBeGreaterThan(5);
      expect(e.html).toContain("<!DOCTYPE html>");
      expect(e.html).toContain("#F94F0C");
      expect(e.html).toContain('name="viewport"');
      expect(e.text).toMatch(/NEXAR/);
      expect(e.text).not.toMatch(/<[a-z]/i);
    }
  });

  it("dado vindo do banco é escapado (sem HTML injetado)", () => {
    const e = renderEmail("quote_request", { sender_name: "<script>x</script>", message_excerpt: '"><img src=x onerror=alert(1)>' }, { appUrl: APP });
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<img src=x");
    expect(e.html).toContain("&lt;script&gt;");
  });

  it("links só internos: externo vira a página inicial", () => {
    expect(appLink(APP, "/Dashboard")).toBe(`${APP}/Dashboard`);
    expect(appLink(APP, "https://phishing.com")).toBe(APP);
    expect(appLink(APP, "//phishing.com")).toBe(APP);
    const e = renderEmail("platform_notification", { title: "X", link: "https://phishing.com" }, { appUrl: APP });
    expect(e.html).not.toContain("phishing.com");
  });

  it("boas-vindas muda o próximo passo para fornecedor", () => {
    expect(renderEmail("welcome", { user_type: "fornecedor" }, { appUrl: APP }).text).toContain("/Planos?onboarding=1");
    expect(renderEmail("welcome", { user_type: "cliente" }, { appUrl: APP }).text).toContain("/Suppliers");
  });

  it("template desconhecido lança", () => {
    expect(() => renderEmail("nao_existe")).toThrow();
    expect(escapeHtml(`a&b<"'>`)).toBe("a&amp;b&lt;&quot;&#39;&gt;");
  });
});

const UUID = "3f1c2a9e-7b4d-4c1e-9a2b-5d6e7f8a9b0c";
const MSG = { apiKey: "xkeysib-x", from: "NEXAR <nao-responda@nexar.com.br>", to: "c@d.com", subject: "S", html: "<p>h</p>", text: "t" };
const resposta = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  headers: { get: (h) => headers[h] ?? null },
});
const erroDe = (status, body = { message: "msg" }, headers) =>
  sendViaBrevo({ ...MSG, fetchImpl: async () => resposta(status, body, headers) }).catch((e) => e);

describe("sendViaBrevo", () => {
  it("sucesso: api-key no header, corpo no formato da Brevo, devolve o messageId", async () => {
    const fetchImpl = vi.fn(async () => resposta(201, { messageId: "<2026.1@smtp-relay.mailin.fr>" }));
    const r = await sendViaBrevo({ ...MSG, replyTo: "contato@nexar.com.br", idempotencyKey: UUID, fetchImpl });
    expect(r.id).toBe("<2026.1@smtp-relay.mailin.fr>");
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(BREVO_URL);
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(opts.method).toBe("POST");
    expect(opts.headers["api-key"]).toBe("xkeysib-x");
    expect(opts.headers.Authorization).toBeUndefined();
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      sender: { name: "NEXAR", email: "nao-responda@nexar.com.br" },
      to: [{ email: "c@d.com" }],
      subject: "S",
      htmlContent: "<p>h</p>",
      textContent: "t",
      replyTo: { email: "contato@nexar.com.br" },
      headers: { idempotencyKey: UUID },
    });
  });

  it("idempotência: chave vai DENTRO do corpo (headers.idempotencyKey), nunca como header HTTP do Resend", async () => {
    const fetchImpl = vi.fn(async () => resposta(201, { messageId: "m" }));
    await sendViaBrevo({ ...MSG, idempotencyKey: UUID, fetchImpl });
    const opts = fetchImpl.mock.calls[0][1];
    expect(opts.headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(opts.body).headers.idempotencyKey).toBe(UUID);
    // A Brevo exige UUID: chave fora do formato é erro de programação.
    await expect(sendViaBrevo({ ...MSG, idempotencyKey: "notification:1", fetchImpl })).rejects.toThrow(/UUID/);
    // Sem chave: corpo sem `headers`.
    await sendViaBrevo({ ...MSG, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)[1].body).headers).toBeUndefined();
  });

  it("202 (agendado) também é sucesso; messageIds como alternativa", async () => {
    const r = await sendViaBrevo({ ...MSG, fetchImpl: async () => resposta(202, { messageIds: ["<a@b>"] }) });
    expect(r.id).toBe("<a@b>");
  });

  it("erros: 400 permanente, 401/403 configuração, 429 limite com espera, 5xx passageiro", async () => {
    expect((await erroDe(400, { code: "invalid_parameter", message: "bad" })).kind).toBe("permanent");
    expect((await erroDe(401, { code: "unauthorized", message: "Key not found" })).kind).toBe("config");
    expect((await erroDe(403, { code: "permission_denied", message: "IP not allowed" })).kind).toBe("config");
    expect((await erroDe(400, { code: "unauthorized", message: "x" })).kind).toBe("config");
    const limite = await erroDe(429, { message: "Too many requests" }, { "retry-after": "12" });
    expect(limite.kind).toBe("rate_limited");
    expect(limite.retryAfter).toBe(12);
    // A Brevo manda o reset do limite em x-sib-ratelimit-reset.
    expect((await erroDe(429, {}, { "x-sib-ratelimit-reset": "40" })).retryAfter).toBe(40);
    expect((await erroDe(500)).kind).toBe("transient");
    expect((await erroDe(503)).kind).toBe("transient");
    const semCorpo = await sendViaBrevo({ ...MSG, fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); }, headers: { get: () => null } }) }).catch((e) => e);
    expect(semCorpo.kind).toBe("transient");
  });

  it("cota esgotada (402 ou not_enough_credits) e duplicado no provedor têm tipo próprio", async () => {
    expect((await erroDe(402, { message: "x" })).kind).toBe("quota");
    expect((await erroDe(400, { code: "not_enough_credits", message: "x" })).kind).toBe("quota");
    expect((await erroDe(400, { code: "duplicate_parameter", message: "x" })).kind).toBe("duplicate");
    expect((await erroDe(400, { code: "duplicate_request", message: "Request already processed" })).kind).toBe("duplicate");
  });

  it("falha de rede e timeout: passageiros", async () => {
    const rede = await sendViaBrevo({ ...MSG, fetchImpl: async () => { throw new TypeError("fetch failed"); } }).catch((e) => e);
    expect(rede).toBeInstanceOf(ProviderError);
    expect(rede.kind).toBe("transient");

    // fetch que só termina quando o sinal aborta.
    const pendurado = (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const lento = await sendViaBrevo({ ...MSG, fetchImpl: pendurado, timeoutMs: 5 }).catch((e) => e);
    expect(lento.kind).toBe("transient");
    expect(lento.message).toMatch(/Tempo esgotado/);
  });

  it("mensagem de erro do provedor não leva o e-mail do destinatário", async () => {
    const e = await erroDe(400, { code: "invalid_parameter", message: "email fulano@empresa.com is invalid" });
    expect(e.message).not.toContain("fulano@empresa.com");
    expect(e.message).toContain("f***@empresa.com");
  });

  it("remetente: aceita 'Nome <email>' e só o e-mail; inválido não chega na rede", async () => {
    expect(parseAddress("NEXAR <a@b.com>")).toEqual({ name: "NEXAR", email: "a@b.com" });
    expect(parseAddress('"NEXAR" <a@b.com>')).toEqual({ name: "NEXAR", email: "a@b.com" });
    expect(parseAddress("a@b.com")).toEqual({ email: "a@b.com" });
    expect(parseAddress("NEXAR <COLE_AQUI>")).toBeNull();
    const fetchImpl = vi.fn();
    await expect(sendViaBrevo({ ...MSG, from: "lixo", fetchImpl })).rejects.toThrow(/Remetente/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(maskEmailsInText("de a@b.com para c@d.com")).toBe("de a***@b.com para c***@d.com");
  });
});

describe("processBatch", () => {
  it("envio transacional: renderiza, envia ao destinatário do banco e marca enviado", async () => {
    const { claim, finish } = fila([linha({ data: { ...linha().data, to: "atacante@x.com" } })]);
    const send = vi.fn(async () => ({ id: "msg_9" }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(r.sent).toBe(1);
    // O destinatário vem de to_email (auth.users), nunca de `data`.
    // A chave de idempotência é o id da linha (UUID), não o dedupe_key.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "dono@empresa.com", idempotencyKey: "r1" }));
    expect(send.mock.calls[0][0].subject).toContain("Embalagens Sul");
    expect(finish).toHaveBeenCalledWith("r1", { status: "sent", providerId: "msg_9" });
  });

  it("destinatário inválido: falha definitiva, sem chamar a Brevo", async () => {
    const { claim, finish } = fila([linha({ to_email: "nao-e-email" }), linha({ id: "r2", dedupe_key: "k2", to_email: null })]);
    const send = vi.fn();
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).not.toHaveBeenCalled();
    expect(r.failed).toBe(2);
    expect(finish).toHaveBeenCalledWith("r1", expect.objectContaining({ status: "failed" }));
  });

  it("erro da Brevo: 400 desiste, 5xx tenta de novo com espera, e desiste na última tentativa", async () => {
    const { claim, finish } = fila([
      linha({ id: "a", dedupe_key: "a" }),
      linha({ id: "b", dedupe_key: "b", attempts: 2 }),
      linha({ id: "c", dedupe_key: "c", attempts: MAX_ATTEMPTS }),
    ]);
    const send = vi.fn()
      .mockRejectedValueOnce(new ProviderError(400, "invalid", { code: "invalid_parameter" }))
      .mockRejectedValueOnce(new ProviderError(503, "down"))
      .mockRejectedValueOnce(new ProviderError(500, "down"));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(r).toMatchObject({ failed: 2, retried: 1 });
    expect(finish).toHaveBeenCalledWith("a", expect.objectContaining({ status: "failed" }));
    expect(finish).toHaveBeenCalledWith("b", expect.objectContaining({ status: "retry", retryAfterSeconds: 300 }));
    expect(finish).toHaveBeenCalledWith("c", expect.objectContaining({ status: "failed" }));
  });

  it("limite (429): devolve o item e o resto do lote sem gastar tentativa, e para", async () => {
    const { claim, finish } = fila([linha({ id: "a", dedupe_key: "a" }), linha({ id: "b", dedupe_key: "b" }), linha({ id: "c", dedupe_key: "c" })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(429, "slow down", { retryAfter: 30 }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ stopped: "rate_limited", retried: 3 });
    expect(finish).toHaveBeenCalledWith("a", expect.objectContaining({ status: "retry", retryAfterSeconds: 30, keepAttempt: false }));
    expect(finish).toHaveBeenCalledWith("c", expect.objectContaining({ status: "retry", keepAttempt: false }));
  });

  it("nova tentativa repete a MESMA chave (a Brevo descarta se a anterior já tinha saído)", async () => {
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(503, "down")).mockResolvedValueOnce({ id: "m" });
    const primeira = fila([linha({ id: UUID, attempts: 1 })]);
    await processBatch({ config: CONFIG, ...primeira, send, sleep: semEspera });
    expect(primeira.finish).toHaveBeenCalledWith(UUID, expect.objectContaining({ status: "retry", retryAfterSeconds: 60 }));
    const segunda = fila([linha({ id: UUID, attempts: 2 })]);
    await processBatch({ config: CONFIG, ...segunda, send, sleep: semEspera });
    expect(send.mock.calls[0][0].idempotencyKey).toBe(UUID);
    expect(send.mock.calls[1][0].idempotencyKey).toBe(UUID);
    expect(segunda.finish).toHaveBeenCalledWith(UUID, { status: "sent", providerId: "m" });
  });

  it("duplicado no provedor (resposta anterior perdida): conta como enviado, com anotação", async () => {
    const { claim, finish } = fila([linha({ attempts: 2 })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(400, "Request already processed", { code: "duplicate_request" }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(r.sent).toBe(1);
    expect(finish).toHaveBeenCalledWith("r1", { status: "sent", error: expect.stringMatching(/Duplicado no provedor/) });
  });

  it("duplicado na 1ª tentativa real (antes só recusas): NÃO marca enviado, espera a chave expirar", async () => {
    const { claim, finish } = fila([linha({ attempts: 1 })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(400, "x", { code: "duplicate_parameter" }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(r).toMatchObject({ sent: 0, retried: 1 });
    expect(finish).toHaveBeenCalledWith("r1", expect.objectContaining({ status: "retry", retryAfterSeconds: DUPLICATE_RETRY_SECONDS, keepAttempt: false }));
    expect(DUPLICATE_RETRY_SECONDS).toBeGreaterThan(30 * 60);
  });

  it("cota esgotada: devolve o lote sem gastar tentativa e só tenta de novo em 1 h", async () => {
    const { claim, finish } = fila([linha({ id: "a", dedupe_key: "a" }), linha({ id: "b", dedupe_key: "b" })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(402, "not enough credits"));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ stopped: "quota", retried: 2 });
    for (const id of ["a", "b"]) {
      expect(finish).toHaveBeenCalledWith(id, expect.objectContaining({ status: "retry", retryAfterSeconds: QUOTA_RETRY_SECONDS, keepAttempt: false }));
    }
  });

  it("chave errada (401): para o lote sem gastar tentativa", async () => {
    const { claim, finish } = fila([linha({ id: "a", dedupe_key: "a" }), linha({ id: "b", dedupe_key: "b" })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(401, "Key not found", { code: "unauthorized" }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(r.stopped).toBe("config");
    expect(finish).toHaveBeenCalledWith("a", expect.objectContaining({ status: "retry", keepAttempt: false }));
    expect(finish).toHaveBeenCalledWith("b", expect.objectContaining({ status: "retry", keepAttempt: false }));
  });

  it("timeout/rede no envio: tenta de novo com espera crescente", async () => {
    const { claim, finish } = fila([linha({ attempts: 3 })]);
    const send = vi.fn().mockRejectedValueOnce(new ProviderError(0, "Tempo esgotado (15000 ms)"));
    await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(finish).toHaveBeenCalledWith("r1", expect.objectContaining({ status: "retry", retryAfterSeconds: 1800 }));
  });

  it("mesmo evento duas vezes no lote: um envio só", async () => {
    const { claim, finish } = fila([linha({ id: "a" }), linha({ id: "b" })]);
    const send = vi.fn(async () => ({ id: "m" }));
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 1, skipped: 1 });
  });

  it("pagamento não sai enquanto o gateway não existe", async () => {
    const { claim, finish } = fila([linha({ template: "payment_failed" })]);
    const send = vi.fn();
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it("modo test: tudo vai para o endereço autorizado, com [TESTE] no assunto", async () => {
    const config = readConfig({ ...process.env, BREVO_API_KEY: "k", EMAIL_FROM: "f <a@b.com>", APP_URL: APP, EMAIL_SENDING_MODE: "test", EMAIL_TEST_TO: "eu@nexar.test" });
    const { claim, finish } = fila([linha()]);
    const send = vi.fn(async () => ({ id: "m" }));
    await processBatch({ config, claim, finish, send, sleep: semEspera });
    expect(send.mock.calls[0][0].to).toBe("eu@nexar.test");
    expect(send.mock.calls[0][0].subject).toMatch(/^\[TESTE\]/);
  });

  it("live: conta de teste (domínio reservado) é ignorada sem chamar a Brevo", async () => {
    const { claim, finish } = fila([linha({ to_email: "teste-limites@nexar.test" })]);
    const send = vi.fn();
    const r = await processBatch({ config: CONFIG, claim, finish, send, sleep: semEspera });
    expect(send).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "skipped" });
  });

  it("test: conta de teste continua saindo (para EMAIL_TEST_TO)", async () => {
    const config = { ...CONFIG, mode: "test", testTo: "eu@empresa.com" };
    const { claim, finish } = fila([linha({ to_email: "teste-limites@nexar.test" })]);
    const send = vi.fn(async () => ({ id: "m" }));
    await processBatch({ config, claim, finish, send, sleep: semEspera });
    expect(send.mock.calls[0][0].to).toBe("eu@empresa.com");
  });

  it("modo disabled ou configuração incompleta: não pega nada da fila", async () => {
    const { claim, finish } = fila([linha()]);
    const send = vi.fn();
    expect((await processBatch({ config: { ...CONFIG, mode: "disabled" }, claim, finish, send })).stopped).toBe("disabled");
    const sem = readConfig({ EMAIL_SENDING_MODE: "test" });
    expect(configProblems(sem).join(" ")).toMatch(/BREVO_API_KEY.*EMAIL_FROM.*APP_URL.*EMAIL_TEST_TO/);
    expect((await processBatch({ config: sem, claim, finish, send, log: () => {} })).stopped).toBe("config");
    expect(claim).not.toHaveBeenCalled();
  });

  it("log nunca leva chave nem e-mail inteiro", async () => {
    const { claim, finish } = fila([linha()]);
    const log = vi.fn();
    await processBatch({ config: CONFIG, claim, finish, send: async () => ({ id: "m" }), log, sleep: semEspera });
    const tudo = JSON.stringify(log.mock.calls);
    expect(tudo).not.toContain("xkeysib-teste-nao-real");
    expect(tudo).not.toContain("dono@empresa.com");
    expect(tudo).toContain("d***@empresa.com");
  });

  it("falha também não vaza e-mail no log nem no last_error", async () => {
    const { claim, finish } = fila([linha()]);
    const log = vi.fn();
    const send = vi.fn().mockRejectedValueOnce(new Error("dono@empresa.com bounced"));
    await processBatch({ config: CONFIG, claim, finish, send, log, sleep: semEspera });
    const tudo = JSON.stringify([log.mock.calls, finish.mock.calls]);
    expect(tudo).not.toContain("dono@empresa.com");
  });

  it("remetente de exemplo (não preenchido) bloqueia o envio", () => {
    expect(configProblems({ ...CONFIG, from: "NEXAR <COLE_AQUI_O_REMETENTE_VERIFICADO_NA_BREVO>" }).join(" ")).toMatch(/EMAIL_FROM inválido/);
    expect(configProblems({ ...CONFIG, replyTo: "x" }).join(" ")).toMatch(/EMAIL_REPLY_TO/);
    expect(configProblems(CONFIG)).toEqual([]);
  });
});

// As duas regras abaixo vivem no SQL (o Vitest não alcança o banco). O teste
// de verdade é supabase/transactional-emails-test.sql (BEGIN/ROLLBACK); aqui
// só se garante que ninguém tirou a regra do arquivo.
describe("transactional-emails.sql (estrutura)", () => {
  const sql = readFileSync(new URL("../../../Backend/supabase/transactional-emails.sql", import.meta.url), "utf8");

  it("fila vence em 48 h, e o tick vence antes de decidir chamar a função", () => {
    expect(sql).toMatch(/function public\.expire_stale_emails\(\)[\s\S]*interval '48 hours'/);
    const tick = sql.slice(sql.indexOf("function public.email_worker_tick()"));
    expect(tick.indexOf("expire_stale_emails()")).toBeGreaterThan(-1);
    expect(tick.indexOf("expire_stale_emails()")).toBeLessThan(tick.indexOf("if not exists"));
  });

  it("limite por usuário/hora conta o próprio lote", () => {
    expect(sql).toMatch(/row_number\(\) over \(partition by o\.to_user_id/);
    expect(sql).toMatch(/enviados_hora \+ f\.rn <= greatest\(p_per_user_hour, 1\)/);
  });

  it("nenhum resto do header de idempotência do Resend", () => {
    expect(sql).not.toMatch(/Idempotency-Key/);
  });
});

describe("envio de teste e autorização", () => {
  it("vai só para EMAIL_TEST_TO", async () => {
    const send = vi.fn(async () => ({ id: "t1" }));
    const r = await sendTestEmail({ config: { ...CONFIG, testTo: "eu@nexar.test" }, send });
    expect(r.ok).toBe(true);
    expect(send.mock.calls[0][0].to).toBe("eu@nexar.test");
    expect(await sendTestEmail({ config: { ...CONFIG, testTo: "" }, send })).toMatchObject({ ok: false });
  });

  it("segredo do worker: só o valor exato passa", () => {
    expect(safeEqual("s3gr3d0-longo", "s3gr3d0-longo")).toBe(true);
    expect(safeEqual("s3gr3d0-longo", "s3gr3d0-longX")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(null, "x")).toBe(false);
  });

  it("porta da função: segredo do servidor ausente/curto = 500; header errado ou ausente = 401", () => {
    const bom = "s".repeat(64);
    expect(authorizeWorker("", bom)).toMatchObject({ ok: false, status: 500, error: "worker_secret_misconfigured" });
    expect(authorizeWorker("curto", "curto")).toMatchObject({ ok: false, status: 500 });
    expect(authorizeWorker(bom, null)).toMatchObject({ ok: false, status: 401, error: "unauthorized" });
    expect(authorizeWorker(bom, "")).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWorker(bom, bom.slice(0, -1) + "x")).toMatchObject({ ok: false, status: 401 });
    expect(authorizeWorker(bom, bom)).toEqual({ ok: true });
    // A resposta nunca devolve o segredo.
    expect(JSON.stringify(authorizeWorker(bom, "x"))).not.toContain(bom);
  });

  it("envio de teste: UUID novo a cada envio", async () => {
    const send = vi.fn(async () => ({ id: "t" }));
    await sendTestEmail({ config: { ...CONFIG, testTo: "eu@empresa.com" }, send, randomUUID: () => UUID });
    expect(send.mock.calls[0][0].idempotencyKey).toBe(UUID);
    await sendTestEmail({ config: { ...CONFIG, testTo: "eu@empresa.com" }, send });
    expect(send.mock.calls[1][0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(send.mock.calls[1][0].idempotencyKey).not.toBe(UUID);
  });

  it("segredo do worker: ausente ou curto é erro de configuração", () => {
    expect(secretProblems("")).toMatch(/ausente/);
    expect(secretProblems("x".repeat(MIN_SECRET_LENGTH - 1))).toMatch(/curto/);
    expect(secretProblems("x".repeat(MIN_SECRET_LENGTH))).toBeNull();
  });

  it("domínios reservados", () => {
    for (const e of ["a@nexar.test", "a@x.example", "a@x.invalid", "a@localhost", "a@example.com", "A@NEXAR.TEST"]) {
      expect(isReservedDomain(e)).toBe(true);
    }
    for (const e of ["a@gmail.com", "a@testes.com.br", "a@example.com.br", "a@test.com"]) {
      expect(isReservedDomain(e)).toBe(false);
    }
  });

  it("validação e máscara de e-mail", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.com")).toBe(false);
    expect(maskEmail("fulano@empresa.com")).toBe("f***@empresa.com");
  });
});
