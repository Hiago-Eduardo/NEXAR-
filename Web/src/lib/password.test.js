import { describe, it, expect } from "vitest";
import { isStrongPassword, passwordChecks, passwordError, MIN_PASSWORD_LENGTH } from "./password";

describe("regra de senha nova (seção 176)", () => {
  it("mínimo de 8", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(isStrongPassword("abc1234")).toBe(false);
    expect(isStrongPassword("abcd1234")).toBe(true);
  });

  it("exige letra e número", () => {
    expect(isStrongPassword("12345678")).toBe(false);
    expect(isStrongPassword("abcdefgh")).toBe(false);
    expect(isStrongPassword("çãoéxyz9")).toBe(true); // letra acentuada conta
  });

  it("mensagem aponta o primeiro requisito que falta", () => {
    expect(passwordError("")).toMatch(/8 caracteres/);
    expect(passwordError("12345678")).toMatch(/letra/);
    expect(passwordError("abcdefgh")).toMatch(/número/);
    expect(passwordError("abcd1234")).toBe("");
  });

  it("lista os três requisitos na ordem da tela", () => {
    expect(passwordChecks("a1").map((c) => [c.key, c.ok])).toEqual([
      ["length", false], ["letter", true], ["number", true],
    ]);
  });
});
