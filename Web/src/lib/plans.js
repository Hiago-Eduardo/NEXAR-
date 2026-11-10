// Shared plan metadata for the fornecedor subscription flow (Planos / Dashboard / AdEditor).
// Ad limits here must stay in sync with plan_ad_limit() in supabase/rls-policies.sql,
// which enforces the same limits server-side.

export const PLAN_LABELS = {
  basico: "Básico",
  profissional: "Profissional",
  premium: "Premium",
};

export const PLAN_AD_LIMITS = {
  basico: 1,
  profissional: 5,
  premium: Infinity,
};

// Preço mensal em reais. Ficava só no array local de Planos.jsx, o que
// bastava enquanto o preço aparecia numa tela só -- desde a seção 121 o
// Dashboard também mostra o VALOR da próxima cobrança (spec §22), e duas
// cópias do preço é o tipo de coisa que diverge sem ninguém notar.
//
// O banco NÃO conhece estes valores: não há cobrança nem coluna de preço.
// Quando o gateway entrar, o preço de verdade passa a ser o do gateway e
// isto aqui vira exibição -- não é fonte da verdade financeira.
export const PLAN_PRICES = {
  basico: 0,
  profissional: 49,
  premium: 99,
};

export function getPlanPrice(planId) {
  return PLAN_PRICES[planId] ?? null;
}

// Limites do catálogo de produtos (por empresa, não por anúncio -- ver
// CONTEXTO.MD/Resumo.md seções 66-67). Mirror de plan_product_limit()/
// plan_product_image_limit() em supabase/product-catalog.sql -- mudar aqui
// exige mudar lá também.
export const PLAN_PRODUCT_LIMITS = {
  basico: 5,
  profissional: 30,
  premium: Infinity,
};

// Imagens da GALERIA DO ANÚNCIO (carrossel no SupplierProfile). Mirror de
// plan_ad_image_limit() em supabase/supplier-gallery.sql.
//
// Mais generoso que PLAN_PRODUCT_IMAGE_LIMITS porque a galeria do anúncio é
// a vitrine principal -- é o que a pessoa olha antes de decidir falar com o
// fornecedor --, enquanto a foto do produto é detalhe. Premium é limitado
// pelo mesmo motivo das fotos de produto: é uma dimensão que não escala com
// nada, e um anúncio não fica melhor com 200 fotos.
export const PLAN_AD_IMAGE_LIMITS = {
  basico: 3,
  profissional: 5,
  premium: 10,
};

export function getPlanAdImageLimit(planId) {
  return PLAN_AD_IMAGE_LIMITS[planId] ?? 0;
}

export const PLAN_PRODUCT_IMAGE_LIMITS = {
  basico: 1,
  profissional: 3,
  premium: 8,
};

export function hasActivePlan(planId) {
  return Boolean(planId) && Object.prototype.hasOwnProperty.call(PLAN_LABELS, planId);
}

export function getPlanAdLimit(planId) {
  return PLAN_AD_LIMITS[planId] ?? 0;
}

export function getPlanProductLimit(planId) {
  return PLAN_PRODUCT_LIMITS[planId] ?? 0;
}

// Limite TOTAL de produtos cadastrados (ativos + pausados + suspensos) --
// mirror de plan_product_total_limit() em supabase/plan-limits-central.sql.
// É IGUAL ao limite de ativos por decisão do usuário (Resumo.md seção 194):
// quem está no limite de ativos não cadastra produto pausado a mais. Se um
// dia mudar, mudar os dois lados juntos.
export function getPlanProductTotalLimit(planId) {
  return getPlanProductLimit(planId);
}

export function getPlanProductImageLimit(planId) {
  return PLAN_PRODUCT_IMAGE_LIMITS[planId] ?? 0;
}

export function formatAdLimit(limit) {
  return limit === Infinity ? "ilimitado" : String(limit);
}

export function formatProductLimit(limit) {
  return limit === Infinity ? "ilimitado" : String(limit);
}

// Hierarquia dos planos -- espelho de plan_rank() em
// supabase/subscription-plan-change.sql. Mudar aqui exige mudar lá também.
export const PLAN_RANKS = { basico: 0, profissional: 1, premium: 2 };

export function getPlanRank(planId) {
  return PLAN_RANKS[planId] ?? -1;
}

/**
 * Classifica a troca de plano. É o que decide, na interface, se a mudança
 * vale agora ou só no dia 10 -- e o texto que o fornecedor lê antes de
 * confirmar. A decisão REAL é sempre do banco (subscribe_to_plan); isto aqui
 * só precisa dizer a MESMA coisa que ele vai fazer.
 *
 * ESPELHO DE supabase/billing-cycle-day-10.sql -- mudar um exige mudar o
 * outro. O que decide é a DIREÇÃO da troca, por getPlanRank():
 *
 *   'same'      -> já é o plano atual, nada a fazer
 *   'new'       -> sem plano vigente: entra agora, primeiro ciclo é parcial
 *   'upgrade'   -> rank maior: vale AGORA, sem cobrança agora
 *   'downgrade' -> rank menor: vale no dia 10, plano atual intacto até lá
 *
 * HISTÓRICO, porque este arquivo já mudou de regra duas vezes e o motivo
 * importa mais que o formato:
 *  - até 09/2026 devolvia upgrade/downgrade, mas subir cobrava de novo no
 *    mesmo dia e o fornecedor PERDIA os dias já pagos (seção 109);
 *  - depois virou immediate/deferred pela pergunta "já paga?", o que
 *    resolveu a perda mas prendeu o upgrade até o fim do ciclo -- quem pagava
 *    mais ficava até 30 dias sem receber o que contratou (seção 120);
 *  - agora volta a olhar a direção, mas sem cobrar na hora: sobe na hora,
 *    desce no dia 10, e em nenhum dos dois se perde dia pago.
 *
 * O BÁSICO NÃO É MAIS UM CASO ESPECIAL AQUI. Com rank 0, sair dele para um
 * plano pago é um upgrade e cai no ramo imediato pela hierarquia, sem `if`
 * próprio. Ele continua sendo especial no BANCO por outro motivo: é grátis e
 * tem expires_at = 'infinity'.
 */
export function classifyPlanChange(currentPlanId, nextPlanId) {
  if (!currentPlanId) return "new";
  if (currentPlanId === nextPlanId) return "same";
  return getPlanRank(nextPlanId) > getPlanRank(currentPlanId) ? "upgrade" : "downgrade";
}

/** A troca vale imediatamente? Assinatura nova e upgrade valem; downgrade espera. */
export function takesEffectNow(change) {
  return change === "new" || change === "upgrade";
}

/**
 * A troca gera cobrança AGORA?
 *
 * Nunca. A data oficial de cobrança do NEXAR é o dia 10 (spec §4), e nem a
 * primeira assinatura nem o upgrade cobram no ato -- o §5 manda liberar o
 * acesso na hora e cobrar no próximo dia 10, e o §6 diz "NÃO realizar
 * cobrança imediata".
 *
 * A função continua existindo, em vez de sumir com as chamadas, porque é ela
 * que decide quem passa pela tela de Pagamento. Quando o gateway entrar, o
 * cadastro do método de pagamento provavelmente volta a acontecer ANTES de
 * liberar o plano, e é aqui que essa regra vai morar.
 */
export function chargesNow() {
  return false;
}

/**
 * Contratação online de plano PAGO disponível? Hoje NÃO (C1, Resumo.md §231).
 *
 * Só controla o que a TELA oferece. Quem garante é o banco:
 * subscribe_to_plan recusa todo plano que não seja o Básico com
 * PAYMENT_REQUIRED (supabase/fix-paid-plan-activation.sql), seja qual for o
 * valor daqui. Mudar isto para true sem o gateway não ativa plano nenhum --
 * só faz a tela oferecer um botão que o banco recusa.
 */
//
// Checkout Asaas (§232): DESLIGADO em todo build de produção. Só liga em
// `npm run dev` com VITE_PAID_CHECKOUT_SANDBOX=true (ex.: em
// .env.development.local), para homologar contra um projeto Supabase de
// TESTE com o Sandbox -- o banco real recusa cobrança (billing_config NULL).
// `import.meta.env` escrito literalmente: o Vite só substitui assim.
export const PAID_CHECKOUT_AVAILABLE =
  import.meta.env.DEV === true && import.meta.env.MODE !== "test" && import.meta.env.VITE_PAID_CHECKOUT_SANDBOX === "true";

/**
 * O fornecedor pode contratar este plano pelo site agora?
 * Pago só com checkout ligado e a partir de "sem plano" ou do Básico --
 * troca entre planos pagos e renovação são decisões pendentes (§232).
 */
export function isPlanPurchasable(planId, currentPlanId = null) {
  if (typeof planId !== "string" || !Object.hasOwn(PLAN_PRICES, planId)) return false;
  if (getPlanPrice(planId) === 0) return true;
  return PAID_CHECKOUT_AVAILABLE && (!currentPlanId || currentPlanId === "basico");
}

export const PAID_PLAN_UNAVAILABLE_TITLE = "Pagamento em preparação";
export const PAID_PLAN_UNAVAILABLE_MESSAGE =
  "A contratação online dos planos pagos ainda não está disponível. Nenhum valor foi cobrado e seu plano atual não mudou.";

/** Texto do toast quando a troca de plano falha. */
export function describePlanChangeError(error) {
  const msg = String(error?.message || "");
  if (/PAYMENT_REQUIRED/.test(msg)) return PAID_PLAN_UNAVAILABLE_MESSAGE;
  if (/ALREADY_ON_PLAN/.test(msg)) return "Este já é o seu plano atual.";
  // Nunca a mensagem crua (código interno, erro de rede, SQL...).
  return "Tente novamente em alguns instantes.";
}

/*
 * Respostas do checkout Asaas (Edge Function billing-checkout, §233-234).
 * O texto é escrito AQUI, para a tela; o código do servidor só escolhe qual.
 * tone "info" = situação esperada (não é erro do usuário nem do sistema);
 * reload = a assinatura pode ter mudado, recarregar.
 */
const CHECKOUT_FEEDBACK = {
  CARD_INVALID: { title: "Confira os dados", description: "Algum dado do cartão ou do titular está incompleto ou inválido.", tone: "error" },
  CARD_DECLINED: { title: "Cartão recusado", description: "A operadora não autorizou o pagamento. Confira os dados ou use outro cartão.", tone: "error" },
  CARD_NOT_AVAILABLE: { title: "Cobrança indisponível", description: "Esta cobrança não pode mais ser paga com cartão. Atualize a página para gerar outra.", tone: "error" },
  CHARGE_IN_PROGRESS: { title: "Cobrança sendo gerada", description: "Sua cobrança está sendo preparada. Tente de novo em alguns segundos.", tone: "info" },
  PREVIOUS_CHARGE_IN_ANALYSIS: { title: "Pagamento aguardando confirmação", description: "Seu pagamento anterior está sendo confirmado pela operadora. Aguarde antes de gerar outra cobrança.", tone: "info" },
  PREVIOUS_CHARGE_PAID: { title: "Pagamento identificado", description: "Encontramos o pagamento da sua cobrança anterior. Seu plano está sendo atualizado.", tone: "info", reload: true },
  PREVIOUS_CHARGE_UNAPPLIED: { title: "Pagamento em análise", description: "Recebemos um pagamento fora do período da cobrança. Nossa equipe vai analisar; o plano não foi ativado e nenhuma nova cobrança será gerada até lá.", tone: "info" },
  PREVIOUS_CHARGE_UNCONFIRMED: { title: "Pagamento em análise", description: "Não conseguimos confirmar a situação da sua cobrança anterior. Ela está em análise; tente de novo mais tarde.", tone: "info" },
  PAYMENT_UNDER_REVIEW: { title: "Pagamento em análise", description: "Há um pagamento anterior em análise na sua conta. Você poderá contratar de novo assim que ele for resolvido.", tone: "info" },
  PENDING_CHARGE_EXISTS: { title: "Você já tem uma cobrança em aberto", description: "Pague a cobrança em aberto ou aguarde o vencimento dela para escolher outro plano.", tone: "info" },
  ALREADY_ON_PAID_PLAN: { title: "Você já tem um plano pago", description: "Troca entre planos pagos ainda não está disponível.", tone: "info", reload: true },
  cpf_cnpj_required: { title: "Complete o cadastro da empresa", description: "Cadastre o CNPJ da empresa em Conta para gerar a cobrança.", tone: "info" },
  name_required: { title: "Complete o cadastro da empresa", description: "Cadastre o nome da empresa em Conta para gerar a cobrança.", tone: "info" },
  NOT_A_SUPPLIER: { title: "Planos são para fornecedores", description: "Só contas de fornecedor contratam planos.", tone: "info" },
  BILLING_DISABLED: { title: PAID_PLAN_UNAVAILABLE_TITLE, description: PAID_PLAN_UNAVAILABLE_MESSAGE, tone: "info" },
  billing_unavailable: { title: PAID_PLAN_UNAVAILABLE_TITLE, description: PAID_PLAN_UNAVAILABLE_MESSAGE, tone: "info" },
  gateway_unavailable: { title: "Pagamento temporariamente indisponível", description: "O serviço de pagamento não respondeu. Nada foi cobrado; tente de novo em alguns minutos.", tone: "error" },
};
CHECKOUT_FEEDBACK.ENVIRONMENT_MISMATCH = CHECKOUT_FEEDBACK.BILLING_DISABLED;

/** O que mostrar para uma resposta do checkout (código + status HTTP). */
export function checkoutFeedback(code, httpStatus = null) {
  if (typeof code === "string" && Object.hasOwn(CHECKOUT_FEEDBACK, code)) return CHECKOUT_FEEDBACK[code];
  if (httpStatus === 0 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) return CHECKOUT_FEEDBACK.gateway_unavailable;
  return { title: "Não foi possível gerar a cobrança", description: "Tente de novo em alguns instantes.", tone: "error" };
}

/**
 * Preço em reais no formato brasileiro: R$ 1.890,00.
 *
 * Existe porque `Number(x).toFixed(2)` produz "1890.00" -- ponto decimal e
 * sem separador de milhar --, e a tela do anúncio chegava a mostrar os DOIS
 * formatos lado a lado: "R$ 350.00" no card do produto e "R$ 350,00" no
 * pedido mínimo, que é texto digitado pelo fornecedor (seção 146).
 *
 * Aceita null/undefined/'' e devolve null, para quem exibe poder colapsar o
 * bloco em vez de imprimir "R$ NaN".
 */
export function formatBRL(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
  });
}
