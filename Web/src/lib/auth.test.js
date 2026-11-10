import { describe, it, expect } from "vitest";
import { authErrorMessage, safeReturnPath } from "./authErrors";
import { isValidCNPJ } from "./cnpj";

describe("authErrorMessage", () => {
  it("traduz pelo código quando o Supabase manda um", () => {
    expect(authErrorMessage({ code: "invalid_credentials", message: "Invalid login credentials" }))
      .toBe("E-mail ou senha incorretos.");
  });

  it("traduz pelo texto quando não há código", () => {
    expect(authErrorMessage({ message: "User already registered" })).toMatch(/Já existe uma conta/);
    expect(authErrorMessage({ message: "Failed to fetch" })).toMatch(/Sem conexão/);
  });

  it("a tradução do login continua casando com o helper do e2e", () => {
    // e2e/helpers.js reconhece login recusado por /e-?mail ou senha/i.
    expect(authErrorMessage({ code: "invalid_credentials" })).toMatch(/e-?mail ou senha/i);
  });

  it("mensagem desconhecida passa como veio; vazia usa o fallback", () => {
    expect(authErrorMessage({ message: "algo novo" })).toBe("algo novo");
    expect(authErrorMessage({}, "padrão")).toBe("padrão");
  });
});

describe("safeReturnPath", () => {
  const origin = "http://localhost:5173";

  it("aceita caminho interno, com query", () => {
    expect(safeReturnPath("/AdEditor?id=123", origin)).toBe("/AdEditor?id=123");
  });

  it("URL completa da própria origem vira caminho", () => {
    expect(safeReturnPath("http://localhost:5173/Dashboard", origin)).toBe("/Dashboard");
  });

  it("recusa outro domínio -- seria redirecionamento aberto", () => {
    expect(safeReturnPath("https://malicioso.com/x", origin)).toBeNull();
    expect(safeReturnPath("//malicioso.com", origin)).toBeNull();
    expect(safeReturnPath("/\\malicioso.com", origin)).toBeNull();
    expect(safeReturnPath("javascript:alert(1)", origin)).toBeNull();
  });

  it("não volta para o próprio login ou cadastro", () => {
    expect(safeReturnPath("/Login", origin)).toBeNull();
    expect(safeReturnPath("/Register?from=/x", origin)).toBeNull();
  });

  it("vazio é null", () => {
    expect(safeReturnPath("", origin)).toBeNull();
    expect(safeReturnPath(null, origin)).toBeNull();
  });
});

describe("isValidCNPJ", () => {
  it("aceita CNPJ válido, com ou sem máscara", () => {
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
    expect(isValidCNPJ("11222333000181")).toBe(true);
  });

  it("recusa dígito verificador errado (erro de digitação)", () => {
    expect(isValidCNPJ("11.222.333/0001-82")).toBe(false);
    expect(isValidCNPJ("11.222.333/0001-91")).toBe(false);
  });

  it("recusa sequência repetida e tamanho errado", () => {
    expect(isValidCNPJ("00.000.000/0000-00")).toBe(false);
    expect(isValidCNPJ("11.111.111/1111-11")).toBe(false);
    expect(isValidCNPJ("11.222.333/0001")).toBe(false);
    expect(isValidCNPJ("")).toBe(false);
  });
});
