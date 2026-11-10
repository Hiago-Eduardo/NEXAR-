import { describe, it, expect } from "vitest";
import { UNIT_GROUPS, CATEGORY_UNIT_GROUPS, ALL_UNITS, getUnitGroupsForCategory, getDefaultUnitForCategory } from "./units";
import { CATEGORY_KEYS } from "./categories";

describe("unidades do catálogo", () => {
  it("cobre as unidades já gravadas no banco (lista antiga e produtos de teste)", () => {
    for (const u of ["un", "kg", "g", "L", "mL", "cx", "pct", "m", "m²", "envio", "viagem", "mês", "palete"]) {
      expect(ALL_UNITS.has(u)).toBe(true);
    }
  });

  it("nenhuma unidade aparece em dois grupos (o Select exige valores únicos)", () => {
    const todas = UNIT_GROUPS.flatMap((g) => g.units);
    expect(new Set(todas).size).toBe(todas.length);
  });

  it("toda categoria mapeada existe em categories.js e aponta para grupos existentes", () => {
    const grupos = new Set(UNIT_GROUPS.map((g) => g.key));
    for (const [cat, keys] of Object.entries(CATEGORY_UNIT_GROUPS)) {
      expect(CATEGORY_KEYS.has(cat)).toBe(true);
      for (const k of keys) expect(grupos.has(k)).toBe(true);
    }
  });

  it("toda categoria de categories.js tem unidades sugeridas", () => {
    for (const cat of CATEGORY_KEYS) {
      expect(CATEGORY_UNIT_GROUPS[cat], cat).toBeDefined();
    }
  });

  it("coloca os grupos sugeridos primeiro, sem esconder nenhum", () => {
    const grupos = getUnitGroupsForCategory("logistica", "envio");
    expect(grupos[0]).toMatchObject({ key: "logistica", suggested: true });
    expect(grupos.length).toBe(UNIT_GROUPS.length);
    expect(grupos.filter((g) => g.suggested).map((g) => g.key)).toEqual(["logistica", "servico"]);
  });

  it("sem categoria, mantém a ordem padrão e nada sugerido", () => {
    const grupos = getUnitGroupsForCategory("", "un");
    expect(grupos.map((g) => g.key)).toEqual(UNIT_GROUPS.map((g) => g.key));
    expect(grupos.some((g) => g.suggested)).toBe(false);
  });

  it("unidade fora da lista vira grupo próprio no topo, para o Select não abrir vazio", () => {
    const grupos = getUnitGroupsForCategory("logistica", "tonelada-km");
    expect(grupos[0]).toMatchObject({ key: "atual", units: ["tonelada-km"] });
  });

  it("unidade inicial segue o primeiro grupo sugerido", () => {
    expect(getDefaultUnitForCategory("logistica")).toBe("envio");
    expect(getDefaultUnitForCategory("alimentos_bebidas")).toBe("kg");
    expect(getDefaultUnitForCategory("servicos_digitais")).toBe("hora");
    expect(getDefaultUnitForCategory("")).toBe("un");
  });
});
