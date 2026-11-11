// UI helpers for the fornecedor subscription lifecycle (Dashboard / Planos / AdEditor).
// These only compute a VISUAL state from a subscription row already fetched from the
// backend (api.subscriptions.getCurrent()). Real authorization always happens server-side
// (RLS + trg_enforce_supplier_ad_rules + the subscribe/cancel/reactivate/sync RPCs in
// supabase/rls-policies.sql), comparing against the database's own now() — never the
// browser clock.
import { differenceInSeconds } from "date-fns";

function expiresAtMs(subscription) {
  if (!subscription?.expires_at) return null;
  const ms = new Date(subscription.expires_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// 'none' | 'active' | 'cancelled_active' | 'suspended' | 'expired'
//
// 'expired' significa ASSINATURA ENCERRADA, e quem está nesse estado está
// SEM PLANO -- nunca é convertido automaticamente em Básico (spec §2). A
// conta, os dados e os anúncios continuam existindo; o que fica suspenso são
// os recursos comerciais (spec §10).
//
// 'suspended' é a assinatura interrompida por falha de pagamento (spec §11).
// Nenhuma função do banco produz esse status hoje -- não há cobrança para
// falhar --, mas a interface já sabe distinguir "acabou" de "falhou", que
// são situações diferentes para quem lê: uma exige escolher plano de novo, a
// outra exige corrigir o pagamento.
export function getSubscriptionState(subscription) {
  if (!subscription) return "none";

  const ms = expiresAtMs(subscription);
  const hasExpired = ms !== null && ms <= Date.now();

  if (subscription.status === "suspended") return "suspended";
  if (subscription.status === "expired" || hasExpired) return "expired";
  if (subscription.status === "cancelled") return "cancelled_active";
  if (subscription.status === "active") return "active";
  return "expired";
}

export function hasUsableBenefits(subscription) {
  const state = getSubscriptionState(subscription);
  return state === "active" || state === "cancelled_active";
}

// Plano basico (gratuito) usa expires_at = 'infinity' e nunca mostra contagem regressiva.
export function hasCountdown(subscription) {
  const ms = expiresAtMs(subscription);
  return ms !== null && Number.isFinite(ms) && ms !== Infinity;
}

// "29 dias, 18 horas restantes" — string apenas visual; quem decide se o plano venceu
// de verdade é o backend (ver comentário no topo do arquivo).
export function formatCountdown(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt);
  const targetMs = target.getTime();
  if (!Number.isFinite(targetMs)) return null; // 'infinity' (plano basico)

  const secondsLeft = differenceInSeconds(target, new Date());
  if (secondsLeft <= 0) return "Plano vencido";

  // Divisão direta: converter meses de calendário em "30 dias" errava prazos
  // acima de um mês (45 dias saíam como 44 -- subscription.test.js).
  const days = Math.floor(secondsLeft / 86400);
  const hours = Math.floor((secondsLeft % 86400) / 3600);

  if (days > 0) {
    return `${days} dia${days !== 1 ? "s" : ""}, ${hours} hora${hours !== 1 ? "s" : ""} restantes`;
  }
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  if (hours > 0) {
    return `${hours} hora${hours !== 1 ? "s" : ""}, ${minutes} minuto${minutes !== 1 ? "s" : ""} restantes`;
  }
  return `${minutes} minuto${minutes !== 1 ? "s" : ""} restantes`;
}

export function formatDatePtBr(dateLike) {
  if (!dateLike) return "";
  const date = new Date(dateLike);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("pt-BR");
}

export const SUBSCRIPTION_STATUS_LABELS = {
  active: "Ativo",
  cancelled: "Cancelado",
  expired: "Encerrado",
  scheduled: "Agendado",
  suspended: "Suspenso",
};

// A data oficial de cobrança do NEXAR é o dia 10 (spec §4). Espelho de
// next_billing_date() em supabase/billing-cycle-day-10.sql.
//
// SÓ PARA EXIBIÇÃO, e por isso é uma estimativa: o navegador não sabe o fuso
// oficial do produto (America/Sao_Paulo) nem o relógio do banco. Quem grava a
// data de verdade é sempre o Postgres, em next_charge_at -- prefira LER esse
// campo quando ele existir na linha, e use esta função apenas quando não
// houver assinatura ainda (ex.: a tela de Planos antes de contratar).
export const BILLING_DAY = 10;

export function nextBillingDateEstimate(from = new Date()) {
  const date = new Date(from);
  if (!Number.isFinite(date.getTime())) return null;
  const next = new Date(date.getFullYear(), date.getMonth(), BILLING_DAY);
  if (date.getDate() >= BILLING_DAY) next.setMonth(next.getMonth() + 1);
  return next;
}
