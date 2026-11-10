import { describe, it, expect } from "vitest";
import {
  confirmRedirectUrl, parseAuthRedirect, resendWaitSeconds, isResendRateLimit,
  isExistingAccountSignup, buildSignupMetadata, RESEND_COOLDOWN_SECONDS,
} from "./signup";

const ORIGEM = "http://localhost:5173";

describe("confirmRedirectUrl", () => {
  it("volta para /ConfirmarEmail na origem atual, levando o from", () => {
    expect(confirmRedirectUrl(ORIGEM)).toBe("http://localhost:5173/ConfirmarEmail");
    expect(confirmRedirectUrl(ORIGEM, "/AdEditor?id=1")).toBe("http://localhost:5173/ConfirmarEmail?from=%2FAdEditor%3Fid%3D1");
  });
});

describe("parseAuthRedirect", () => {
  it("confirmação bem-sucedida: token no hash", () => {
    const r = parseAuthRedirect(`${ORIGEM}/ConfirmarEmail#access_token=abc&refresh_token=x&expires_in=3600&token_type=bearer&type=signup`);
    expect(r).toEqual({ status: "confirmed", type: "signup" });
  });

  it("link expirado ou reusado: otp_expired", () => {
    const r = parseAuthRedirect(`${ORIGEM}/ConfirmarEmail#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    expect(r.status).toBe("expired");
    expect(r.description).toBe("Email link is invalid or has expired");
  });

  it("outros erros, no hash ou na query: inválido", () => {
    expect(parseAuthRedirect(`${ORIGEM}/ConfirmarEmail#error=server_error&error_description=x`).status).toBe("invalid");
    expect(parseAuthRedirect(`${ORIGEM}/ConfirmarEmail?error=access_denied&error_code=bad_jwt`).status).toBe("invalid");
  });

  it("sem nada na URL (ou URL quebrada): none", () => {
    expect(parseAuthRedirect(`${ORIGEM}/ConfirmarEmail?from=%2FDashboard`).status).toBe("none");
    expect(parseAuthRedirect("não é url").status).toBe("none");
  });
});

describe("reenvio: limite de frequência", () => {
  it("usa os segundos que o Supabase informar, senão o padrão", () => {
    expect(resendWaitSeconds({ message: "For security purposes, you can only request this after 42 seconds." })).toBe(42);
    expect(resendWaitSeconds({ message: "Email rate limit exceeded" })).toBe(RESEND_COOLDOWN_SECONDS);
  });

  it("reconhece o erro de limite por código, status ou texto", () => {
    expect(isResendRateLimit({ code: "over_email_send_rate_limit" })).toBe(true);
    expect(isResendRateLimit({ status: 429 })).toBe(true);
    expect(isResendRateLimit({ message: "you can only request this after 30 seconds" })).toBe(true);
    expect(isResendRateLimit({ code: "email_address_invalid" })).toBe(false);
  });
});

describe("isExistingAccountSignup", () => {
  it("usuário sem identidades = e-mail já cadastrado", () => {
    expect(isExistingAccountSignup({ user: { identities: [] }, session: null })).toBe(true);
    expect(isExistingAccountSignup({ user: { identities: [{ id: "1" }] }, session: null })).toBe(false);
    expect(isExistingAccountSignup({ user: {} })).toBe(false);
  });
});

describe("buildSignupMetadata", () => {
  const form = {
    full_name: " Ana Souza ", cnpj: "11.222.333/0001-81", company_name: "Empresa X",
    email: "ana@x.com", phone: "", cep: "01001000", city: "São Paulo", state: "SP", segment: "embalagens",
  };

  it("perfil vai em nexar_profile, só com campos preenchidos e sem o e-mail", () => {
    const m = buildSignupMetadata(form, "fornecedor");
    expect(m).toMatchObject({ full_name: "Ana Souza", user_type: "fornecedor", role: "fornecedor" });
    expect(m.nexar_profile).toEqual({
      user_type: "fornecedor", full_name: "Ana Souza", cnpj: "11.222.333/0001-81", company_name: "Empresa X",
      cep: "01001000", city: "São Paulo", state: "SP", segment: "embalagens",
    });
    expect(m.nexar_profile).not.toHaveProperty("phone");
    expect(m.nexar_profile).not.toHaveProperty("email");
  });

  it("tipo desconhecido vira cliente; nunca admin", () => {
    expect(buildSignupMetadata(form, "admin").role).toBe("cliente");
    expect(buildSignupMetadata(form, "admin").nexar_profile.user_type).toBe("cliente");
    expect(buildSignupMetadata({ ...form, role: "admin" }, "cliente").nexar_profile).not.toHaveProperty("role");
  });
});
