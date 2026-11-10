import { describe, it, expect, vi } from "vitest";
import { normalizeCEP, formatCEP, isValidCEP, cepForStorage, isMissingCepColumn, saveWithOptionalCep } from "./cep";

describe("isValidCEP", () => {
  it("aceita 8 dígitos, com ou sem a máscara", () => {
    expect(isValidCEP("01001000")).toBe(true);
    expect(isValidCEP("01001-000")).toBe(true);
  });

  it("recusa incompleto, com letras e com dígitos a mais", () => {
    expect(isValidCEP("0100100")).toBe(false);
    expect(isValidCEP("01001-00")).toBe(false);
    expect(isValidCEP("0100A000")).toBe(false);
    expect(isValidCEP("ABCDE-FGH")).toBe(false);
    expect(isValidCEP("010010000")).toBe(false);
    expect(isValidCEP("")).toBe(false);
  });
});

describe("normalizeCEP / formatCEP / cepForStorage", () => {
  it("zeros à esquerda: sempre string, nunca número", () => {
    expect(normalizeCEP("01001-000")).toBe("01001000");
    expect(cepForStorage("01001-000")).toBe("01001000");
    expect(typeof cepForStorage("01001-000")).toBe("string");
    expect(formatCEP("00000001")).toBe("00000-001");
  });

  it("máscara enquanto digita descarta letras", () => {
    expect(formatCEP("0100")).toBe("0100");
    expect(formatCEP("010010")).toBe("01001-0");
    expect(formatCEP("01a001b000")).toBe("01001-000");
    expect(formatCEP("0100100099")).toBe("01001-000");
  });

  it("vazio ou incompleto não é gravado", () => {
    expect(cepForStorage("")).toBeNull();
    expect(cepForStorage("0100")).toBeNull();
    expect(cepForStorage(null)).toBeNull();
  });
});

describe("saveWithOptionalCep (coluna ainda não criada)", () => {
  const semColuna = Object.assign(new Error("Could not find the 'cep' column of 'user_profiles' in the schema cache"), { code: "PGRST204" });

  it("reconhece só o erro de coluna cep inexistente", () => {
    expect(isMissingCepColumn(semColuna)).toBe(true);
    expect(isMissingCepColumn({ code: "PGRST204", message: "Could not find the 'phone' column" })).toBe(false);
    expect(isMissingCepColumn({ code: "42501", message: "cep" })).toBe(false);
  });

  it("sem a coluna, grava o resto sem o CEP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const save = vi.fn().mockRejectedValueOnce(semColuna).mockResolvedValueOnce({ id: 1 });
    await expect(saveWithOptionalCep(save, { city: "São Paulo", cep: "01001000" })).resolves.toEqual({ id: 1 });
    expect(save).toHaveBeenNthCalledWith(2, { city: "São Paulo" });
    warn.mockRestore();
  });

  it("qualquer outro erro sobe como veio, sem nova tentativa", async () => {
    const save = vi.fn().mockRejectedValue(new Error("RLS"));
    await expect(saveWithOptionalCep(save, { cep: "01001000" })).rejects.toThrow("RLS");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
