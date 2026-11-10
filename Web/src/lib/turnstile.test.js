import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isTestSiteKey, resolveSiteKey, contactCaptchaEnabled, captchaReducer, captchaAllowsSubmit, captchaHint,
  isCaptchaError, loadTurnstileScript, __resetTurnstileLoader, CAPTCHA_INITIAL, TURNSTILE_SCRIPT_URL,
} from "./turnstile";
import { authErrorMessage } from "./authErrors";

describe("site key", () => {
  it("reconhece as chaves de teste oficiais da Cloudflare", () => {
    for (const k of ["1x00000000000000000000AA", "2x00000000000000000000AB", "1x00000000000000000000BB", "3x00000000000000000000FF"]) {
      expect(isTestSiteKey(k)).toBe(true);
    }
    expect(isTestSiteKey("0x4AAAAAAAB1c2d3e4f5g6h7")).toBe(false);
    expect(isTestSiteKey("")).toBe(false);
  });

  it("sem chave: sem CAPTCHA no navegador (comportamento antigo)", () => {
    expect(resolveSiteKey({})).toBeNull();
    expect(resolveSiteKey({ VITE_TURNSTILE_SITE_KEY: "  " })).toBeNull();
  });

  it("dev aceita chave de teste; produção a recusa e avisa", () => {
    expect(resolveSiteKey({ VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA", PROD: false })).toBe("1x00000000000000000000AA");
    const log = { error: vi.fn() };
    expect(resolveSiteKey({ VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000AA", PROD: true }, log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/TESTE/));
    expect(resolveSiteKey({ VITE_TURNSTILE_SITE_KEY: "0x4AAAAAAAB1c2d3e4f5g6h7", PROD: true }, log)).toBe("0x4AAAAAAAB1c2d3e4f5g6h7");
  });

  it("orçamento com CAPTCHA só com a flag explícita", () => {
    expect(contactCaptchaEnabled({})).toBe(false);
    expect(contactCaptchaEnabled({ VITE_TURNSTILE_CONTACT_REQUIRED: "1" })).toBe(false);
    expect(contactCaptchaEnabled({ VITE_TURNSTILE_CONTACT_REQUIRED: "true" })).toBe(true);
  });
});

describe("estado do desafio", () => {
  const passo = (eventos, inicial = CAPTCHA_INITIAL) => eventos.reduce(captchaReducer, inicial);

  it("só libera o envio com token válido", () => {
    expect(captchaAllowsSubmit(CAPTCHA_INITIAL)).toBe(false);
    expect(captchaAllowsSubmit(passo([{ type: "rendered" }]))).toBe(false);
    const ok = passo([{ type: "rendered" }, { type: "success", token: "tok" }]);
    expect(ok).toEqual({ status: "verified", token: "tok" });
    expect(captchaAllowsSubmit(ok)).toBe(true);
  });

  it("token é de uso único: depois de consumido, bloqueia até o novo desafio", () => {
    const usado = passo([{ type: "success", token: "tok" }, { type: "consumed" }]);
    expect(usado.token).toBeNull();
    expect(captchaAllowsSubmit(usado)).toBe(false);
    expect(captchaAllowsSubmit(captchaReducer(usado, { type: "success", token: "novo" }))).toBe(true);
  });

  it("expirado, erro e indisponível limpam o token e bloqueiam, com mensagem", () => {
    for (const type of ["expired", "error", "unavailable"]) {
      const s = passo([{ type: "success", token: "tok" }, { type }]);
      expect(s.token).toBeNull();
      expect(captchaAllowsSubmit(s)).toBe(false);
      expect(captchaHint(s)).not.toBe("");
    }
    expect(captchaHint({ status: "unavailable" })).toMatch(/carregar/);
  });

  it("widget desmontado (reset) descarta o token: não sobra token velho para depois", () => {
    const s = passo([{ type: "success", token: "tok" }, { type: "reset" }, { type: "rendered" }]);
    expect(s.token).toBeNull();
    expect(captchaAllowsSubmit(s)).toBe(false);
  });

  it("re-render do widget não apaga um token já obtido", () => {
    expect(passo([{ type: "success", token: "tok" }, { type: "rendered" }]).token).toBe("tok");
  });

  it("desligado: sempre libera, sem mensagem", () => {
    const s = captchaReducer(CAPTCHA_INITIAL, { type: "disabled" });
    expect(captchaAllowsSubmit(s)).toBe(true);
    expect(captchaHint(s)).toBe("");
  });
});

describe("erro de CAPTCHA do Supabase Auth", () => {
  it("é reconhecido pelo código e pelo texto", () => {
    expect(isCaptchaError({ code: "captcha_failed", message: "x" })).toBe(true);
    expect(isCaptchaError({ message: "captcha protection: request disallowed (timeout-or-duplicate)" })).toBe(true);
    expect(isCaptchaError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(false);
    expect(isCaptchaError(null)).toBe(false);
  });

  it("vira mensagem em português", () => {
    expect(authErrorMessage({ code: "captcha_failed" })).toMatch(/verificação de segurança/);
    expect(authErrorMessage({ message: "captcha protection: request disallowed (invalid-input-response)" })).toMatch(/verificação de segurança/);
  });
});

describe("carregamento do script", () => {
  beforeEach(() => __resetTurnstileLoader());

  function fakeDom() {
    const listeners = {};
    const script = {
      src: "", addEventListener: (ev, fn) => { listeners[ev] = fn; }, remove: vi.fn(),
    };
    const doc = {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => script),
      head: { appendChild: vi.fn() },
    };
    return { doc, script, listeners };
  }

  it("injeta o script uma vez e resolve com window.turnstile", async () => {
    const { doc, script, listeners } = fakeDom();
    const win = {};
    const p1 = loadTurnstileScript({ doc, win, timeoutMs: 1000 });
    const p2 = loadTurnstileScript({ doc, win, timeoutMs: 1000 });
    expect(p1).toBe(p2);
    expect(doc.head.appendChild).toHaveBeenCalledTimes(1);
    expect(script.src).toBe(TURNSTILE_SCRIPT_URL);
    win.turnstile = { render: vi.fn() };
    listeners.load();
    await expect(p1).resolves.toBe(win.turnstile);
  });

  it("falha de rede (bloqueador, CSP) rejeita e permite tentar de novo", async () => {
    const { doc, listeners, script } = fakeDom();
    const p = loadTurnstileScript({ doc, win: {}, timeoutMs: 1000 });
    listeners.error();
    await expect(p).rejects.toThrow("network");
    expect(script.remove).toHaveBeenCalled();
    loadTurnstileScript({ doc, win: {}, timeoutMs: 1000 }).catch(() => {});
    expect(doc.head.appendChild).toHaveBeenCalledTimes(2);
  });

  it("demora demais: rejeita por timeout", async () => {
    const { doc } = fakeDom();
    await expect(loadTurnstileScript({ doc, win: {}, timeoutMs: 5 })).rejects.toThrow("timeout");
  });

  it("script carregou mas sem window.turnstile: rejeita", async () => {
    const { doc, listeners } = fakeDom();
    const p = loadTurnstileScript({ doc, win: {}, timeoutMs: 1000 });
    listeners.load();
    await expect(p).rejects.toThrow("missing_global");
  });
});

describe("leitura das variáveis do Vite", () => {
  it("usa import.meta.env literal (o Vite não reconhece outra forma)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./turnstile.js", import.meta.url), "utf8");
    // Só o código: o comentário do arquivo cita a forma errada como exemplo.
    const codigo = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(codigo).not.toMatch(/\(import\.meta\)\.env/);
    expect(codigo).toMatch(/resolveSiteKey\(env = import\.meta\.env,/);
    expect(codigo).toMatch(/contactCaptchaEnabled\(env = import\.meta\.env\)/);
  });
});
