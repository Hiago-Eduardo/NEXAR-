import React, { useEffect } from "react";
import { api } from "@/api/client";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CreditCard, Info, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { Panel } from "../components/shared/Panel";
import CheckoutPanel from "../components/payment/CheckoutPanel";
import { PLAN_LABELS, getPlanPrice, formatBRL, PAID_CHECKOUT_AVAILABLE } from "@/lib/plans";
import { getSubscriptionState, formatDatePtBr, nextBillingDateEstimate } from "@/lib/subscription";

// TELA HONESTA (seção 169). Até aqui ela era toda simulada: um cartão
// "Visa •••• 4242" que ninguém salvou, um formulário que pedia número e CVV
// de cartão e os jogava fora, um código PIX falso, "pagamento seguro com
// criptografia SSL" -- e uma troca de plano paralela à do Planos, sem a
// confirmação que explica quando a troca vale e quando é cobrada.
//
// Não existe gateway. Então a tela mostra só o que é verdade: o plano, a
// próxima data de cobrança que o banco calculou, o histórico de payments
// (vazio até o gateway existir) e o aviso de que a forma de pagamento ainda
// não é cadastrada pelo site. A troca de plano fica no Planos, que é o único
// lugar que a faz. Quando o gateway entrar, o cadastro do método de pagamento
// entra no painel "Forma de pagamento".

const PAYMENT_STATUS = {
  pending: "Pendente",
  approved: "Pago",
  refused: "Recusado",
  refunded: "Estornado",
};

export default function Pagamento() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // §239: ?plan=<pago> abre a cobrança aqui mesmo (Pix/boleto/cartão).
  const checkoutPlan = searchParams.get("plan");
  const showCheckout = PAID_CHECKOUT_AVAILABLE && getPlanPrice(checkoutPlan) > 0;
  const { user, isLoadingAuth, authChecked } = useAuth();
  const isFornecedor = user?.role === "fornecedor" || user?.role === "admin";

  useEffect(() => {
    if (authChecked && !user) {
      api.auth.redirectToLogin("/Pagamento");
    } else if (authChecked && user && !isFornecedor) {
      // Cliente não tem plano: mesmo destino do Dashboard (seção 165).
      navigate(createPageUrl("Suppliers"), { replace: true });
    }
  }, [authChecked, user, isFornecedor, navigate]);

  const enabled = !!user && isFornecedor;
  const { data: subscription, isLoading: loadingSub } = useQuery({
    queryKey: ["pagamento-subscription", user?.id],
    queryFn: () => api.subscriptions.getCurrent(),
    enabled,
  });
  const { data: scheduled } = useQuery({
    queryKey: ["pagamento-scheduled", user?.id],
    queryFn: () => api.subscriptions.getScheduled().catch(() => null),
    enabled,
  });
  const { data: payments = [], isError: paymentsError } = useQuery({
    queryKey: ["pagamento-history", user?.id],
    queryFn: () => api.payments.getHistory(),
    enabled,
  });

  if (isLoadingAuth || !user || !isFornecedor) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-orange-500 rounded-full animate-spin" />
      </div>
    );
  }

  const state = getSubscriptionState(subscription);
  const planId = subscription?.plan_id;
  const price = getPlanPrice(planId);
  const isPaid = price > 0;
  // Data gravada pelo banco quando existe; a estimativa é só reserva.
  const nextCharge = subscription?.next_charge_at || (isPaid ? nextBillingDateEstimate() : null);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center gap-4">
          <Link to={createPageUrl("Dashboard")}>
            <Button variant="ghost" size="sm" className="gap-1.5 text-slate-500 dark:text-slate-400">
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Button>
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="font-display font-extrabold text-slate-900 dark:text-slate-50">Pagamento</h1>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {showCheckout && <CheckoutPanel planId={checkoutPlan} />}

        {/* Na cobrança (§240) a tela fica só com o checkout, como numa
            assinatura de streaming; o resto volta sem ?plan=. */}
        {!showCheckout && <>
        <Panel title="Seu plano" bodyClassName="p-5 space-y-4">
          {loadingSub ? (
            <p className="text-sm text-slate-400 dark:text-slate-500">Carregando…</p>
          ) : state === "none" || state === "expired" || state === "suspended" ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Você não tem um plano ativo. Seus anúncios só aparecem com um plano.
            </p>
          ) : (
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">
                  {PLAN_LABELS[planId] || planId}
                </p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {state === "cancelled_active"
                    ? `Cancelado — os benefícios valem até ${formatDatePtBr(subscription.expires_at)}.`
                    : isPaid && !PAID_CHECKOUT_AVAILABLE
                      // C1 (Resumo.md §231): nada renova nem é cobrado ainda.
                      ? `Válido até ${formatDatePtBr(subscription.expires_at)}. A renovação online ainda está em preparação.`
                      : isPaid && nextCharge
                        ? `Próxima cobrança: ${formatDatePtBr(nextCharge)}.`
                        : "Plano gratuito, sem cobrança."}
                </p>
                {scheduled && (
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Troca para o {PLAN_LABELS[scheduled.plan_id] || scheduled.plan_id} agendada para{" "}
                    {formatDatePtBr(scheduled.started_at)}.
                  </p>
                )}
              </div>
              <div className="tnum font-display text-2xl font-black text-slate-900 dark:text-slate-50">
                {isPaid ? formatBRL(price) : "Grátis"}
                {isPaid && <span className="text-sm font-semibold text-slate-400 dark:text-slate-500">/mês</span>}
              </div>
            </div>
          )}
          <Link to={`${createPageUrl("Planos")}?manage=1`} className="inline-block">
            <Button variant="outline" className="rounded-card">
              {state === "none" || state === "expired" || state === "suspended" ? "Escolher um plano" : "Trocar de plano"}
            </Button>
          </Link>
        </Panel>

        {!showCheckout && <Panel title="Forma de pagamento" bodyClassName="p-5">
          <div className="flex gap-3 rounded-card border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-800/40">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
            <div className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <p className="font-semibold text-slate-800 dark:text-slate-100">
                O pagamento pelo site ainda não está disponível.
              </p>
              <p>
                Por enquanto nenhum cartão ou PIX é pedido aqui. Quando a cobrança online começar,
                você cadastra a forma de pagamento nesta tela, antes da primeira cobrança.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
            <CreditCard className="h-4 w-4" /> Nenhuma forma de pagamento cadastrada.
          </div>
        </Panel>}

        <Panel title="Histórico de pagamentos" bodyClassName="p-5">
          {paymentsError ? (
            <p className="text-sm text-red-500 dark:text-red-400">Não foi possível carregar o histórico.</p>
          ) : payments.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-slate-400 dark:text-slate-500">
              <Receipt className="h-4 w-4" /> Nenhum pagamento registrado.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-slate-800 dark:text-slate-100">
                      {/* billing_cycle é `date` ("2026-10-10"): new Date() leria
                          como meia-noite UTC e mostraria o dia 09 no Brasil. */}
                      {PLAN_LABELS[p.plan_id] || p.plan_id} · ciclo {String(p.billing_cycle).split("-").reverse().join("/")}
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{PAYMENT_STATUS[p.status] || p.status}</p>
                  </div>
                  <span className="tnum font-semibold text-slate-900 dark:text-slate-50">
                    {formatBRL(p.amount_cents / 100)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        </>}
      </div>
    </div>
  );
}
