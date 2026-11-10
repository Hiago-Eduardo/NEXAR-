import { describe, it, expect, vi } from "vitest";
import {
  verifyTurnstile, validateContactRequest, parseHostnames, captchaReasonMessage, SITEVERIFY_URL, CONTACT_LIMITS,
} from "../../../Backend/supabase/functions/_shared/turnstile.js";

// Nada sai para a rede: a Cloudflare é mock.
const resposta = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const verificar = (body, extra = {}) =>
  verifyTurnstile({ secret: "s", token: "tok", fetchImpl: async () => resposta(body), ...extra });

describe("verifyTurnstile (Siteverify)", () => {
  it("token válido: chama a Cloudflare com secret, response e remoteip", async () => {
    const fetchImpl = vi.fn(async () => resposta({ success: true, hostname: "nexar.com.br", action: "contact_request" }));
    const r = await verifyTurnstile({ secret: "seg", token: "tok", remoteip: "1.2.3.4", fetchImpl, expectedAction: "contact_request", allowedHostnames: ["nexar.com.br"] });
    expect(r).toEqual({ ok: true, hostname: "nexar.com.br", action: "contact_request" });
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe(SITEVERIFY_URL);
    const form = new URLSearchParams(opts.body);
    expect(form.get("secret")).toBe("seg");
    expect(form.get("response")).toBe("tok");
    expect(form.get("remoteip")).toBe("1.2.3.4");
  });

  it("token inválido, vencido ou já usado: recusa", async () => {
    expect(await verificar({ success: false, "error-codes": ["invalid-input-response"] })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await verificar({ success: false, "error-codes": ["timeout-or-duplicate"] })).toMatchObject({ ok: false, reason: "expired_or_used" });
  });

  it("sem token ou sem secret: recusa SEM chamar a Cloudflare", async () => {
    const fetchImpl = vi.fn();
    expect(await verifyTurnstile({ secret: "s", token: "", fetchImpl })).toMatchObject({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstile({ secret: "s", token: undefined, fetchImpl })).toMatchObject({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstile({ secret: "s", token: "x".repeat(2049), fetchImpl })).toMatchObject({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstile({ secret: "", token: "tok", fetchImpl })).toMatchObject({ ok: false, reason: "missing_secret" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falha fechada: Cloudflare fora do ar, erro HTTP, rede, timeout ou resposta estranha", async () => {
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: async () => resposta({}, 500) })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: async () => { throw new TypeError("fetch failed"); } })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await verificar({ success: false, "error-codes": ["internal-error"] })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await verificar({})).toMatchObject({ ok: false });
    expect(await verificar({ success: "true" })).toMatchObject({ ok: false });
    const pendurado = (_u, opts) => new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    expect(await verifyTurnstile({ secret: "s", token: "t", fetchImpl: pendurado, timeoutMs: 5 })).toMatchObject({ ok: false, reason: "unavailable", codes: ["timeout"] });
  });

  it("hostname fora da lista e action errada: recusa", async () => {
    expect(await verificar({ success: true, hostname: "site-falso.com" }, { allowedHostnames: ["nexar.com.br"] })).toMatchObject({ ok: false, reason: "hostname_mismatch" });
    expect(await verificar({ success: true, hostname: "NEXAR.com.br" }, { allowedHostnames: ["nexar.com.br"] })).toMatchObject({ ok: true });
    expect(await verificar({ success: true, action: "login" }, { expectedAction: "contact_request" })).toMatchObject({ ok: false, reason: "action_mismatch" });
  });

  it("lista de hostnames e mensagens", () => {
    expect(parseHostnames(" nexar.com.br, WWW.nexar.com.br ,")).toEqual(["nexar.com.br", "www.nexar.com.br"]);
    expect(captchaReasonMessage("expired_or_used")).toMatch(/expirou ou já foi usada/);
    expect(captchaReasonMessage("qualquer")).toMatch(/falhou/);
  });
});

describe("validateContactRequest", () => {
  const base = {
    supplier_id: "3f1c2a9e-7b4d-4c1e-9a2b-5d6e7f8a9b0c", sender_name: " Ana ", sender_email: "ana@empresa.com",
    sender_phone: "", message: "Preciso de 500 caixas.",
  };

  it("lista branca: campos extras (created_by, status) são descartados", () => {
    const r = validateContactRequest({ ...base, created_by: "outra-conta", status: "replied", captchaToken: "t" });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value).sort()).toEqual(["message", "sender_email", "sender_name", "sender_phone", "supplier_id"]);
    expect(r.value.sender_name).toBe("Ana");
  });

  it("recusa campo obrigatório vazio, e-mail inválido, id inválido e texto grande demais", () => {
    expect(validateContactRequest({ ...base, supplier_id: "1" }).errors).toContain("supplier_id");
    expect(validateContactRequest({ ...base, sender_email: "x" }).errors).toContain("sender_email");
    expect(validateContactRequest({ ...base, message: "  " }).errors).toContain("message");
    expect(validateContactRequest({ ...base, message: "a".repeat(CONTACT_LIMITS.message + 1) }).errors).toContain("message");
    expect(validateContactRequest(null).ok).toBe(false);
  });
});
