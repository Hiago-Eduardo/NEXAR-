import { describe, it, expect } from "vitest";
import { Store } from "lucide-react";
import { CATEGORIES, CATEGORY_KEYS, FOOTER_CATEGORY_KEYS, categoryHint, categoryIcon, categoryLabel } from "./categories";

describe("categorias", () => {
  it("chaves e nomes únicos, todas com ícone", () => {
    expect(CATEGORY_KEYS.size).toBe(CATEGORIES.length);
    expect(new Set(CATEGORIES.map((c) => c.label)).size).toBe(CATEGORIES.length);
    for (const c of CATEGORIES) {
      expect(c.key).toMatch(/^[a-z_]+$/);
      expect(c.icon, c.key).toBeTruthy();
    }
  });

  it("mantém as chaves já gravadas no banco", () => {
    for (const k of [
      "alimentos_bebidas", "moda_vestuario", "tecnologia", "embalagens", "materia_prima",
      "servicos_digitais", "logistica", "cosmeticos_beleza", "papelaria", "artesanato",
    ]) {
      expect(CATEGORY_KEYS.has(k), k).toBe(true);
    }
  });

  it("está em ordem alfabética (ordem das listas de escolha)", () => {
    const labels = CATEGORIES.map((c) => c.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, "pt-BR")));
  });

  it("chave desconhecida: nome como está e ícone genérico", () => {
    expect(categoryLabel("construcao_reforma")).toBe("Construção e Reforma");
    expect(categoryLabel("antiga")).toBe("antiga");
    expect(categoryIcon("antiga")).toBe(Store);
    expect(categoryIcon("")).toBe(Store);
    expect(categoryIcon("agropecuaria")).not.toBe(Store);
  });

  it("nomes usam 'e', não '&'", () => {
    for (const c of CATEGORIES) expect(c.label, c.key).not.toContain("&");
  });

  it("rodapé: só categorias que existem, sem repetir, menos que o total", () => {
    for (const k of FOOTER_CATEGORY_KEYS) expect(CATEGORY_KEYS.has(k), k).toBe(true);
    expect(new Set(FOOTER_CATEGORY_KEYS).size).toBe(FOOTER_CATEGORY_KEYS.length);
    expect(FOOTER_CATEGORY_KEYS.length).toBeLessThan(CATEGORIES.length);
  });

  it("dica só onde existe", () => {
    expect(categoryHint("construcao_reforma")).toMatch(/cimento/);
    expect(categoryHint("papelaria")).toBe("");
    expect(categoryHint("")).toBe("");
  });
});
