import { describe, it, expect } from "vitest";
import { formatNameList, summarizePlanPreview, previewHasChanges } from "./planLimitsPreview";

const item = (name) => ({ id: name, name });

describe("formatNameList", () => {
  it("junta com vírgula e 'e'", () => {
    expect(formatNameList(["A"])).toBe("A");
    expect(formatNameList(["A", "B"])).toBe("A e B");
    expect(formatNameList(["A", "B", "C"])).toBe("A, B e C");
  });

  it("resume o que passa do máximo", () => {
    expect(formatNameList(["A", "B", "C", "D", "E"])).toBe("A, B, C e mais 2");
  });

  it("não imprime nome vazio", () => {
    expect(formatNameList(["", null])).toBe("Sem nome e Sem nome");
  });
});

describe("summarizePlanPreview", () => {
  it("lista o que sai antes do que volta, anúncios antes de produtos", () => {
    const lines = summarizePlanPreview({
      ads: { suspend: [item("P7"), item("P6")], restore: [] },
      products: { suspend: [item("x")], restore: [item("y")] },
    });
    expect(lines.map((l) => `${l.direction}:${l.label}:${l.names}`)).toEqual([
      "suspend:2 anúncios:P7 e P6",
      "suspend:1 produto:x",
      "restore:1 produto:y",
    ]);
  });

  it("nada muda -> vazio", () => {
    const preview = { ads: { suspend: [], restore: [] }, products: { suspend: [], restore: [] } };
    expect(summarizePlanPreview(preview)).toEqual([]);
    expect(previewHasChanges(preview)).toBe(false);
    expect(previewHasChanges(null)).toBe(false);
  });
});
