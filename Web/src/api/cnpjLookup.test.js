import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  lookupCNPJ, normalizeBrasilApiCompany, buildFillProposals, applyFillProposals,
  titleCaseCity, lookupStateFor, _resetCnpjLookupState,
} from "./cnpjLookup";

// Nenhum teste aqui sai para a rede: todo fetch é mock.

const VALIDO = "11.222.333/0001-81";

const RESPOSTA = {
  cnpj: "11222333000181",
  razao_social: "EMPRESA EXEMPLO LTDA",
  nome_fantasia: "EXEMPLO",
  municipio: "SAO JOSE DOS CAMPOS",
  uf: "sp",
  descricao_situacao_cadastral: "ATIVA",
  cnae_fiscal_descricao: "Fabricação de embalagens de papel",
  qsa: [{ nome_socio: "FULANO DE TAL", cnpj_cpf_do_socio: "***123456**" }],
  email: "contato@exemplo.com",
  ddd_telefone_1: "1199999999",
};

function resposta(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => _resetCnpjLookupState());
afterEach(() => vi.useRealTimers());

describe("normalizeBrasilApiCompany", () => {
  it("mapeia os campos usados e descarta sócios, e-mail e telefone", () => {
    const n = normalizeBrasilApiCompany(RESPOSTA);
    expect(n).toEqual({
      cnpj: "11222333000181",
      razaoSocial: "EMPRESA EXEMPLO LTDA",
      nomeFantasia: "EXEMPLO",
      cidade: "Sao Jose dos Campos",
      uf: "SP",
      situacao: "ATIVA",
      ativa: true,
      atividade: "Fabricação de embalagens de papel",
    });
    expect(JSON.stringify(n)).not.toMatch(/FULANO|contato@|1199999999/);
  });

  it("empresa com situação diferente de ativa", () => {
    const n = normalizeBrasilApiCompany({ ...RESPOSTA, descricao_situacao_cadastral: "BAIXADA" });
    expect(n.ativa).toBe(false);
    expect(n.situacao).toBe("BAIXADA");
  });

  it("titleCaseCity", () => {
    expect(titleCaseCity("RIO DE JANEIRO")).toBe("Rio de Janeiro");
    expect(titleCaseCity(null)).toBe("");
  });
});

describe("lookupCNPJ", () => {
  it("CNPJ inválido não chama a rede", async () => {
    const fetchImpl = vi.fn();
    await expect(lookupCNPJ("11.222.333/0001-82", { fetchImpl })).rejects.toMatchObject({ code: "invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sucesso: consulta pelo CNPJ normalizado e devolve dados normalizados", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, RESPOSTA));
    const r = await lookupCNPJ(VALIDO, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://brasilapi.com.br/api/cnpj/v1/11222333000181", expect.any(Object));
    expect(r.razaoSocial).toBe("EMPRESA EXEMPLO LTDA");
  });

  it("alfanumérico válido vai para a consulta normalizado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(400, { message: "CNPJ inválido" }));
    await expect(lookupCNPJ("12.abc.345/01de-35", { fetchImpl })).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchImpl.mock.calls[0][0]).toMatch(/12ABC34501DE35$/);
  });

  it("repetir a consulta usa o cache; consultas simultâneas viram uma só", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(200, RESPOSTA));
    await Promise.all([lookupCNPJ(VALIDO, { fetchImpl }), lookupCNPJ("11222333000181", { fetchImpl })]);
    await lookupCNPJ(VALIDO, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("404 = não localizado, e também fica no cache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resposta(404, { message: "não encontrado" }));
    await expect(lookupCNPJ(VALIDO, { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    await expect(lookupCNPJ(VALIDO, { fetchImpl })).rejects.toMatchObject({ code: "not_found" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falhas da API nunca dizem que o CNPJ é inválido, e não ficam no cache", async () => {
    for (const [status, code] of [[400, "bad_request"], [503, "unavailable"], [500, "unavailable"]]) {
      _resetCnpjLookupState();
      const fetchImpl = vi.fn().mockResolvedValue(resposta(status, {}));
      const erro = await lookupCNPJ(VALIDO, { fetchImpl }).catch((e) => e);
      expect(erro.code).toBe(code);
      expect(erro.message).not.toMatch(/^CNPJ inválido/);
      await lookupCNPJ(VALIDO, { fetchImpl }).catch(() => {});
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("429 pausa as consultas por 30 s, sem sair para a rede", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(resposta(429, {}));
    await expect(lookupCNPJ(VALIDO, { fetchImpl })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(lookupCNPJ("12.ABC.345/01DE-35", { fetchImpl })).rejects.toMatchObject({ code: "rate_limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31000);
    fetchImpl.mockResolvedValue(resposta(200, RESPOSTA));
    await expect(lookupCNPJ(VALIDO, { fetchImpl })).resolves.toMatchObject({ uf: "SP" });
  });

  it("rede fora do ar = indisponível", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(lookupCNPJ(VALIDO, { fetchImpl })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("timeout: aborta depois de 10 s", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const p = lookupCNPJ(VALIDO, { fetchImpl });
    const verificacao = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await verificacao;
  });
});

describe("buildFillProposals / applyFillProposals", () => {
  const empresa = normalizeBrasilApiCompany(RESPOSTA);

  it("campos vazios: propõe preencher, marcado", () => {
    const p = buildFillProposals(empresa, { company_name: "", city: "", state: "" });
    expect(p.map((x) => [x.field, x.kind, x.selected])).toEqual([
      ["company_name", "fill", true],
      ["city", "fill", true],
      ["state", "fill", true],
    ]);
    expect(applyFillProposals(p)).toEqual({ company_name: "EMPRESA EXEMPLO LTDA", city: "Sao Jose dos Campos", state: "SP" });
  });

  it("campos já preenchidos: nunca sobrescreve sem marcar", () => {
    const form = { company_name: "Minha Empresa", city: "são josé dos campos", state: "RJ" };
    const p = buildFillProposals(empresa, form);
    expect(p.find((x) => x.field === "company_name")).toMatchObject({ kind: "replace", selected: false, current: "Minha Empresa" });
    expect(p.find((x) => x.field === "state")).toMatchObject({ kind: "replace", selected: false });
    expect(applyFillProposals(p)).toEqual({});
    // Só o que a pessoa marcou.
    const marcado = p.map((x) => (x.field === "state" ? { ...x, selected: true } : x));
    expect(applyFillProposals(marcado)).toEqual({ state: "SP" });
  });

  it("valor igual (ignorando caixa) não vira proposta de troca", () => {
    const p = buildFillProposals(empresa, { company_name: "empresa exemplo ltda", city: "", state: "SP" });
    expect(p.find((x) => x.field === "company_name").kind).toBe("same");
    expect(p.find((x) => x.field === "state").kind).toBe("same");
  });

  it("campo que a consulta não trouxe fica de fora; nome fantasia e CNAE nunca viram campo", () => {
    const p = buildFillProposals({ ...empresa, cidade: "" }, {});
    expect(p.map((x) => x.field)).toEqual(["company_name", "state"]);
    expect(p.map((x) => x.field)).not.toContain("segment");
  });
});

describe("lookupStateFor (alterar o CNPJ depois da consulta)", () => {
  const consultado = { status: "success", cnpj: "11222333000181", data: { razaoSocial: "X" }, error: null };

  it("mesmo CNPJ, com ou sem máscara: mantém o resultado", () => {
    expect(lookupStateFor(consultado, "11.222.333/0001-81")).toBe(consultado);
    expect(lookupStateFor(consultado, "11222333000181")).toBe(consultado);
  });

  it("CNPJ alterado (ou apagado): resultado anterior invalidado", () => {
    expect(lookupStateFor(consultado, "11.222.333/0001-8").status).toBe("idle");
    expect(lookupStateFor(consultado, "12.ABC.345/01DE-35").status).toBe("idle");
    expect(lookupStateFor(consultado, "").status).toBe("idle");
  });
});
