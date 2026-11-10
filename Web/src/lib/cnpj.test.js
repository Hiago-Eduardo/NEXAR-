import { describe, it, expect } from "vitest";
import { isValidCNPJ, normalizeCNPJ, formatCNPJ, isAlphanumericCNPJ } from "./cnpj";

describe("isValidCNPJ -- numérico", () => {
  it("aceita válido com e sem máscara", () => {
    expect(isValidCNPJ("11.222.333/0001-81")).toBe(true);
    expect(isValidCNPJ("11222333000181")).toBe(true);
    // Zeros à esquerda: por isso CNPJ é string, nunca número.
    expect(isValidCNPJ("00.000.000/0001-91")).toBe(true);
  });

  it("recusa dígito verificador errado, sequência repetida e tamanho errado", () => {
    expect(isValidCNPJ("11.222.333/0001-82")).toBe(false);
    expect(isValidCNPJ("11.111.111/1111-11")).toBe(false);
    expect(isValidCNPJ("112223330001811")).toBe(false);
    expect(isValidCNPJ("1122233300018")).toBe(false);
    expect(isValidCNPJ(null)).toBe(false);
  });
});

describe("isValidCNPJ -- alfanumérico (2026)", () => {
  it("aceita o exemplo oficial da Receita, com ou sem máscara e em minúsculas", () => {
    expect(isValidCNPJ("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCNPJ("12ABC34501DE35")).toBe(true);
    expect(isValidCNPJ("12.abc.345/01de-35")).toBe(true);
  });

  it("recusa DV errado, DV com letra e caractere fora de 0-9/A-Z", () => {
    expect(isValidCNPJ("12.ABC.345/01DE-36")).toBe(false);
    expect(isValidCNPJ("12.ABC.345/01DE-3A")).toBe(false);
    expect(isValidCNPJ("AAAAAAAAAAAAAA")).toBe(false);
  });

  it("isAlphanumericCNPJ só olha se há letra", () => {
    expect(isAlphanumericCNPJ("12.ABC.345/01DE-35")).toBe(true);
    expect(isAlphanumericCNPJ("11.222.333/0001-81")).toBe(false);
  });
});

describe("normalizeCNPJ / formatCNPJ", () => {
  it("normaliza tirando máscara e pondo maiúscula", () => {
    expect(normalizeCNPJ(" 12.abc.345/01de-35 ")).toBe("12ABC34501DE35");
  });

  it("mascara enquanto digita, numérico e alfanumérico", () => {
    expect(formatCNPJ("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatCNPJ("12abc34501de35")).toBe("12.ABC.345/01DE-35");
    expect(formatCNPJ("1122")).toBe("11.22");
    expect(formatCNPJ("11222333")).toBe("11.222.333");
  });

  it("DV só aceita dígitos e o total para em 14 caracteres", () => {
    expect(formatCNPJ("12ABC34501DEX35999")).toBe("12.ABC.345/01DE-35");
  });
});
