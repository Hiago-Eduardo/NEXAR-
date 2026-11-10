// Texto da prévia de troca de plano / cancelamento (preview_my_plan_change em
// supabase/plan-limits-ux.sql). O banco devolve, para anúncios e produtos,
// as listas `suspend` (saem do ar) e `restore` (voltam ao ar), cada item
// com { id, name }. Aqui é só leitura e texto.

const NOUNS = {
  ads: ["anúncio", "anúncios"],
  products: ["produto", "produtos"],
};

function countPhrase(n, [singular, plural]) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "A, B e C" -- ou "A, B, C e mais 4" quando passa de `max`. */
export function formatNameList(names = [], max = 3) {
  const clean = names.map((n) => (n || "").trim() || "Sem nome");
  if (clean.length <= max) {
    return clean.length <= 1 ? clean.join("") : `${clean.slice(0, -1).join(", ")} e ${clean[clean.length - 1]}`;
  }
  return `${clean.slice(0, max).join(", ")} e mais ${clean.length - max}`;
}

/**
 * Linhas da prévia, já em texto. Cada linha:
 *   { direction: 'suspend' | 'restore', kind: 'ads' | 'products', count, label, names }
 * Vazio quando nada muda.
 */
export function summarizePlanPreview(preview) {
  if (!preview) return [];
  const lines = [];
  for (const direction of ["suspend", "restore"]) {
    for (const kind of ["ads", "products"]) {
      const items = preview?.[kind]?.[direction] || [];
      if (items.length === 0) continue;
      lines.push({
        direction,
        kind,
        count: items.length,
        label: countPhrase(items.length, NOUNS[kind]),
        names: formatNameList(items.map((i) => i.name)),
      });
    }
  }
  return lines;
}

export function previewHasChanges(preview) {
  return summarizePlanPreview(preview).length > 0;
}
