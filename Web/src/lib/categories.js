// Categorias oficiais do NEXAR -- fonte ÚNICA (seção 213). Toda tela que
// mostra, filtra ou escolhe categoria importa daqui: formulários (AdEditor,
// Register, Conta, Catálogo), listagem (Suppliers), grade da Home
// (CategoryGrid), cartão (SupplierCard) e anúncio (SupplierProfile).
// Antes três dessas telas tinham cópia própria da lista, e uma categoria
// nova aparecia sem nome e sem ícone nelas.
//
// A chave é o que fica gravado no banco (suppliers.category,
// products.category, user_profiles.segment) -- NUNCA renomeie uma chave
// existente; para mudar o texto, mude só o label. Não há CHECK no banco.
// Categoria nova também precisa de entrada em CATEGORY_UNIT_GROUPS
// (src/lib/units.js) -- o units.test.js cobra.
//
// `hint` (opcional) diz o que entra na categoria; aparece abaixo do campo
// de categoria nos formulários (CategoryHint.jsx) e no título do bloco da
// grade da Home.
//
// Ordem alfabética: é a ordem das listas de escolha. A grade da Home
// reordena pela quantidade de anúncios.
import {
  BookOpen, BrickWall, Car, Factory, Gem, Globe, HardHat, Monitor, Package,
  Palette, Shirt, Sofa, SprayCan, Sparkles, Stethoscope, Store, Tractor, Truck,
  UtensilsCrossed, Wrench, Zap,
} from "lucide-react";

export const CATEGORIES = [
  { key: "agropecuaria", label: "Agropecuária", icon: Tractor },
  { key: "alimentos_bebidas", label: "Alimentos e Bebidas", icon: UtensilsCrossed },
  { key: "artesanato", label: "Artesanato", icon: Palette },
  { key: "automotivo_pecas", label: "Automotivo e Peças", icon: Car },
  {
    key: "construcao_reforma", label: "Construção e Reforma", icon: BrickWall,
    hint: "Tintas, vernizes, pisos, cimento e materiais hidráulicos.",
  },
  { key: "cosmeticos_beleza", label: "Cosméticos e Beleza", icon: Sparkles },
  { key: "eletrica_iluminacao", label: "Elétrica e Iluminação", icon: Zap },
  { key: "embalagens", label: "Embalagens", icon: Package },
  { key: "epi_seguranca", label: "EPIs e Segurança do Trabalho", icon: HardHat },
  { key: "ferramentas_ferragens", label: "Ferramentas e Ferragens", icon: Wrench },
  { key: "limpeza_higiene", label: "Limpeza e Higiene", icon: SprayCan },
  { key: "logistica", label: "Logística", icon: Truck },
  { key: "maquinas_equipamentos", label: "Máquinas e Equipamentos", icon: Factory },
  { key: "materia_prima", label: "Matéria Prima", icon: Gem },
  { key: "moda_vestuario", label: "Moda e Vestuário", icon: Shirt },
  { key: "moveis_decoracao", label: "Móveis e Decoração", icon: Sofa },
  { key: "papelaria", label: "Papelaria", icon: BookOpen },
  { key: "saude_hospitalar", label: "Saúde e Produtos Hospitalares", icon: Stethoscope },
  { key: "servicos_digitais", label: "Serviços Digitais", icon: Globe },
  { key: "tecnologia", label: "Tecnologia", icon: Monitor },
];

// As do rodapé (seção 215): lista fixa e curta, o resto fica atrás de
// "Ver todas". Fixa de propósito -- ordenar por anúncios exigiria uma
// consulta a mais em toda página só para o rodapé.
export const FOOTER_CATEGORY_KEYS = [
  "alimentos_bebidas", "construcao_reforma", "embalagens", "limpeza_higiene",
  "logistica", "maquinas_equipamentos", "moda_vestuario", "tecnologia",
];

export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c.label])
);

export const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/** Nome da categoria; chave desconhecida (dado antigo) aparece como está. */
export function categoryLabel(key) {
  return CATEGORY_LABELS[key] || key;
}

/** Dica opcional do que entra na categoria (`hint`); "" quando não há. */
export function categoryHint(key) {
  return CATEGORIES.find((c) => c.key === key)?.hint || "";
}

/** Ícone da categoria; sem categoria ou desconhecida -> Store. */
export function categoryIcon(key) {
  return CATEGORIES.find((c) => c.key === key)?.icon || Store;
}
