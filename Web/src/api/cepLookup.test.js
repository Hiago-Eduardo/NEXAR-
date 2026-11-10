import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lookupCEP, normalizeViaCep, buildCepFillProposals, cepLookupStateFor, _resetCepLookupState,
} from "./cepLookup";
import { applyFillProposals, buildFillProposals, normalizeBrasilApiCompany } from "./cnpjLookup";

// Nenhum teste sai para a rede: todo fetch é mock.

const SE = {
  cep: "01001-000",
  logradouro: "Praça da Sé",
  complemento: "lado ímpar",
  bairro: "Sé",
  localidade: "São Paulo",
  uf: "SP",
  ibge: "3550308",
};

function resposta(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => _resetCepLookupState());
afterEach(() => vi.useRealTimers());

describe("normalizeViaCep", () => {
  it("CEP válido (01001000): rua, bairro, cidade e UF", () => {
    expect(normalizeViaCep(SE)).toEqual({ cep: "01001000", rua: "Praça da Sé", bairro: "Sé", cidade: "São Paulo", uf: "SP" });
  });

  it("erro: true (ou \"true\") = não encontrado", () => {
    expect(normalizeViaCep({ erro: true })).toBeNull();
    expect(normalizeViaCep({ erro: "true" })).toBeNull();
  });
});

describe("lookupCEP", () => {
  it("CEP válido: consulta o ViaCEP só com dígitos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, SE));
    const r = await lookupCEP("01001-000", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://viacep.com.br/ws/01001000/json/", expect.any(Object));
    expect(r.cidade).toBe("São Paulo");
  });

  it("CEP inexistente (99999999): erro true -> not_found, e fica no cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, { erro: true }));
    await expect(lookupCEP("99999999", { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    await expect(lookupCEP("99999-999", { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("incompleto ou com letras: não chama a rede", async () => {
    const fetchImpl = vi.fn();
    for (const cep of ["0100100", "0100A000", "", "01001-00"]) {
      await expect(lookupCEP(cep, { fetchImpl })).rejects.toMatchObject({ code: "invalid" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("zeros à esquerda chegam inteiros na URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, { ...SE, cep: "00000-001" }));
    await lookupCEP("00000-001", { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://viacep.com.br/ws/00000001/json/");
  });

  it("repetir a consulta usa o cache; simultâneas viram uma só", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, SE));
    await Promise.all([lookupCEP("01001000", { fetchImpl }), lookupCEP("01001-000", { fetchImpl })]);
    await lookupCEP("01001000", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serviço indisponível (5xx, rede, 429): erro próprio, sem cache", async () => {
    for (const [mock, code] of [
      [() => Promise.resolve(resposta(503, {})), "unavailable"],
      [() => Promise.reject(new TypeError("Failed to fetch")), "unavailable"],
      [() => Promise.resolve(resposta(429, {})), "rate_limited"],
    ]) {
      _resetCepLookupState();
      const fetchImpl = vi.fn(mock);
      await expect(lookupCEP("01001000", { fetchImpl })).rejects.toMatchObject({ code });
      await lookupCEP("01001000", { fetchImpl }).catch(() => {});
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("timeout: aborta depois de 8 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const p = lookupCEP("01001000", { fetchImpl });
    const verificacao = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await verificacao;
  });
});

describe("buildCepFillProposals", () => {
  const endereco = normalizeViaCep(SE);

  it("só cidade e UF viram campo; rua e bairro não", () => {
    const p = buildCepFillProposals(endereco, { city: "", state: "" });
    expect(p.map((x) => [x.field, x.kind, x.selected])).toEqual([["city", "fill", true], ["state", "fill", true]]);
    expect(applyFillProposals(p)).toEqual({ city: "São Paulo", state: "SP" });
  });

  it("campos previamente preenchidos pela pessoa: nunca sobrescreve sem marcar", () => {
    const p = buildCepFillProposals(endereco, { city: "Campinas", state: "SP" });
    expect(p.find((x) => x.field === "city")).toMatchObject({ kind: "replace", selected: false, current: "Campinas" });
    expect(p.find((x) => x.field === "state").kind).toBe("same");
    expect(applyFillProposals(p)).toEqual({});
  });

  it("depois da consulta de CNPJ: conflito vira escolha, não sobrescrita", () => {
    // CNPJ preencheu "Rio de Janeiro"/RJ; o CEP diz São Paulo/SP.
    const empresa = normalizeBrasilApiCompany({ municipio: "RIO DE JANEIRO", uf: "RJ", razao_social: "X" });
    const form = { company_name: "", city: "", state: "", ...applyFillProposals(buildFillProposals(empresa, { company_name: "", city: "", state: "" })) };
    expect(form).toMatchObject({ city: "Rio de Janeiro", state: "RJ" });
    const p = buildCepFillProposals(endereco, form);
    expect(p.every((x) => x.kind === "replace" && !x.selected)).toBe(true);
    // Só o que a pessoa marcar.
    expect(applyFillProposals(p.map((x) => ({ ...x, selected: x.field === "state" })))).toEqual({ state: "SP" });
  });

  it("CNPJ sem acento e CEP com acento: propõe a troca, desmarcada", () => {
    const p = buildCepFillProposals(endereco, { city: "Sao Paulo", state: "SP" });
    expect(p.find((x) => x.field === "city")).toMatchObject({ kind: "replace", selected: false, value: "São Paulo" });
  });
});

describe("cepLookupStateFor (alterar o CEP depois da consulta)", () => {
  const consultado = { status: "success", cep: "01001000", data: {}, error: null };

  it("mesmo CEP com ou sem máscara mantém; alterado ou apagado invalida", () => {
    expect(cepLookupStateFor(consultado, "01001-000")).toBe(consultado);
    expect(cepLookupStateFor(consultado, "01001-001").status).toBe("idle");
    expect(cepLookupStateFor(consultado, "0100").status).toBe("idle");
    expect(cepLookupStateFor(consultado, "").status).toBe("idle");
  });
});
