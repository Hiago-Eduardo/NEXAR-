// Unidades de preço dos produtos do catálogo ("R$ 350,00/envio").
//
// `products.unit` é texto livre no banco -- a lista vive só aqui, na
// interface. Antes eram 9 unidades fixas, todas de produto físico, e um
// fornecedor de serviço ou logística não tinha como dizer "por viagem" ou
// "por hora" (seção 151 do Resumo.md).
//
// A lista é SEMPRE a mesma, agrupada; a categoria do produto só muda a
// ORDEM dos grupos (os que combinam vêm primeiro, marcados como sugeridos).
// Esconder unidades por categoria seria pior: todo fornecedor tem um caso
// que foge da regra, e ele ficaria sem saída.

export const UNIT_GROUPS = [
  { key: "unidade", label: "Unidade e embalagem", units: ["un", "par", "dz", "kit", "cx", "pct", "fardo", "saco", "rolo", "palete"] },
  { key: "peso_volume", label: "Peso e volume", units: ["kg", "g", "t", "L", "mL", "m³"] },
  { key: "medida", label: "Medida", units: ["m", "m²", "cm"] },
  { key: "servico", label: "Serviço", units: ["hora", "diária", "mês", "ano", "projeto", "licença", "usuário"] },
  { key: "logistica", label: "Logística", units: ["envio", "entrega", "viagem", "km"] },
];

// Grupos sugeridos por categoria (chaves de src/lib/categories.js), em ordem
// de relevância. O primeiro grupo também dá a unidade inicial de um produto
// novo quando o fornecedor escolhe a categoria antes de mexer na unidade.
export const CATEGORY_UNIT_GROUPS = {
  alimentos_bebidas: ["peso_volume", "unidade"],
  moda_vestuario: ["unidade"],
  tecnologia: ["unidade", "servico"],
  embalagens: ["unidade", "medida"],
  materia_prima: ["peso_volume", "medida"],
  servicos_digitais: ["servico"],
  logistica: ["logistica", "servico"],
  cosmeticos_beleza: ["unidade", "peso_volume"],
  papelaria: ["unidade"],
  artesanato: ["unidade"],
  construcao_reforma: ["unidade", "peso_volume", "medida"],
  maquinas_equipamentos: ["unidade", "servico"],
  ferramentas_ferragens: ["unidade"],
  eletrica_iluminacao: ["unidade", "medida"],
  limpeza_higiene: ["unidade", "peso_volume"],
  epi_seguranca: ["unidade"],
  agropecuaria: ["peso_volume", "unidade"],
  automotivo_pecas: ["unidade"],
  moveis_decoracao: ["unidade", "medida"],
  saude_hospitalar: ["unidade"],
};

export const DEFAULT_UNIT = "un";

export const ALL_UNITS = new Set(UNIT_GROUPS.flatMap((g) => g.units));

/**
 * Grupos na ordem de exibição para a categoria dada: os sugeridos primeiro
 * (com `suggested: true`), depois os demais na ordem padrão.
 *
 * `currentUnit` fora da lista (produto antigo, ou gravado direto no banco)
 * vira um grupo próprio no topo -- sem isso o Select abre VAZIO na edição,
 * que era o bug da seção 151.
 */
export function getUnitGroupsForCategory(category, currentUnit) {
  const suggestedKeys = CATEGORY_UNIT_GROUPS[category] || [];
  const suggested = suggestedKeys
    .map((key) => UNIT_GROUPS.find((g) => g.key === key))
    .filter(Boolean)
    .map((g) => ({ ...g, suggested: true }));
  const rest = UNIT_GROUPS.filter((g) => !suggestedKeys.includes(g.key)).map((g) => ({ ...g, suggested: false }));

  const groups = [...suggested, ...rest];
  if (currentUnit && !ALL_UNITS.has(currentUnit)) {
    groups.unshift({ key: "atual", label: "Unidade atual", units: [currentUnit], suggested: false });
  }
  return groups;
}

/** Unidade inicial para a categoria: a primeira do primeiro grupo sugerido (logística -> "envio", alimentos -> "kg"). */
export function getDefaultUnitForCategory(category) {
  const firstKey = CATEGORY_UNIT_GROUPS[category]?.[0];
  const group = UNIT_GROUPS.find((g) => g.key === firstKey);
  return group ? group.units[0] : DEFAULT_UNIT;
}
