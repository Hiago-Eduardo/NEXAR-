// Os quatro estados de um anúncio ou produto, como o banco os grava
// (supabase/plan-limits-central.sql, Resumo.md seções 184-185):
//
//   active                  status='active'                              conta no limite
//   paused                  status='paused'     -- decisão do fornecedor  não conta
//   suspended_plan_limit    status='suspended', reason='plan_limit'      não conta
//   suspended_no_plan       status='suspended', reason='no_plan'         não conta
//
// Quem SUSPENDE e RESTAURA é só o banco (apply_plan_limits). O cliente pode
// pausar/ativar, nunca tirar da suspensão -- o banco recusa (AD_SUSPENDED /
// PRODUCT_SUSPENDED). A única porta é a TROCA (swap_plan_slot, plan-limits-
// ux.sql): um suspenso pelo limite entra no lugar de um ativo. Aqui é só
// leitura e texto.

export function getItemState(item) {
  const status = item?.status || "active";
  if (status === "paused") return "paused";
  if (status !== "suspended") return "active";
  // Suspenso sem motivo = suspensão anterior à coluna suspension_reason, que
  // só existia por falta de plano.
  return item?.suspension_reason === "plan_limit" ? "suspended_plan_limit" : "suspended_no_plan";
}

export const ITEM_STATE_LABELS = {
  active: "Ativo",
  paused: "Pausado",
  suspended_plan_limit: "Suspenso pelo limite do plano",
  suspended_no_plan: "Suspenso: sem plano",
};

export function isSystemSuspended(item) {
  return (item?.status || "active") === "suspended";
}

/** Conta itens por estado: { active, paused, suspended_plan_limit, suspended_no_plan }. */
export function countItemStates(items = []) {
  const counts = { active: 0, paused: 0, suspended_plan_limit: 0, suspended_no_plan: 0 };
  for (const item of items) counts[getItemState(item)] += 1;
  return counts;
}

/**
 * Texto para quando o fornecedor tenta reativar um item suspenso. `noun` é
 * "anúncio" ou "produto".
 */
export function describeSuspension(item, noun) {
  if (getItemState(item) === "suspended_plan_limit") {
    return {
      title: `${capitalize(noun)} suspenso pelo limite do plano`,
      description: `Seu plano comporta menos ${noun}s ativos do que você tem. Use "Colocar no ar" para escolher qual ativo sai no lugar dele, ou mude para um plano maior. Nada foi apagado.`,
    };
  }
  return {
    title: `${capitalize(noun)} suspenso`,
    description: `Assine um plano para voltar a exibir este ${noun}. Ele não foi apagado.`,
  };
}

/**
 * Traduz os erros que o banco levanta ao criar/ativar/pausar. Devolve null
 * quando não é um erro de regra de plano (aí quem chama mostra o original).
 * As mensagens do banco vêm sem acento ("PLAN_LIMIT: voce atingiu...").
 */
export function planRuleErrorMessage(message, noun) {
  const msg = message || "";
  // Antes de PLAN_LIMIT: "SWAP_NOT_PLAN_LIMIT" contém "PLAN_LIMIT".
  if (/SWAP_NOT_PLAN_LIMIT/.test(msg)) return `Só um ${noun} suspenso pelo limite do plano pode entrar no lugar de outro.`;
  if (/SWAP_NOT_ACTIVE/.test(msg)) return `O ${noun} escolhido para sair não está mais ativo. Atualize a página e tente de novo.`;
  if (/SWAP_NOT_FOUND|SWAP_INVALID/.test(msg)) return `Não foi possível encontrar os ${noun}s da troca. Atualize a página e tente de novo.`;
  if (/AD_SUSPENDED|PRODUCT_SUSPENDED/.test(msg)) {
    return `Este ${noun} foi suspenso pelo sistema e volta sozinho quando o plano permitir.`;
  }
  if (/SYSTEM_STATUS/.test(msg)) return `Apenas o sistema suspende ${noun}s.`;
  if (/PLAN_REQUIRED/.test(msg)) return `Você precisa de um plano ativo para publicar este ${noun}.`;
  if (/PLAN_LIMIT/.test(msg) && /ativos/.test(msg)) {
    return `Você já tem o máximo de ${noun}s ativos do seu plano. Pause outro ou mude de plano.`;
  }
  if (/PLAN_LIMIT/.test(msg)) return `Você atingiu o limite de ${noun}s do seu plano. Mude de plano para ter mais.`;
  return null;
}

function capitalize(texto) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
