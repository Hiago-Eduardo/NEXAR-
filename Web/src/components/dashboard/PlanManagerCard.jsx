import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Clock, History } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { createPageUrl } from "@/utils";
import { api } from "@/api/client";
import { PLAN_LABELS, formatAdLimit, getPlanPrice, PAID_CHECKOUT_AVAILABLE } from "@/lib/plans";
import PlanLimitsImpact from "@/components/shared/PlanLimitsImpact";
import {
  getSubscriptionState, hasCountdown, formatCountdown, formatDatePtBr,
  SUBSCRIPTION_STATUS_LABELS
} from "@/lib/subscription";

function useLiveCountdown(expiresAt, enabled) {
  const [label, setLabel] = useState(() => (enabled ? formatCountdown(expiresAt) : null));

  useEffect(() => {
    if (!enabled) {
      setLabel(null);
      return;
    }
    setLabel(formatCountdown(expiresAt));
    const interval = setInterval(() => setLabel(formatCountdown(expiresAt)), 30_000);
    return () => clearInterval(interval);
  }, [expiresAt, enabled]);

  return label;
}

export default function PlanManagerCard({
  userId, subscription, adsUsed, adLimit, onCancel, onReactivate, cancelling, reactivating,
}) {
  const state = getSubscriptionState(subscription);
  const showCountdown = hasCountdown(subscription) && (state === "active" || state === "cancelled_active");
  const countdown = useLiveCountdown(subscription?.expires_at, showCountdown);

  const { data: history = [] } = useQuery({
    queryKey: ["my-subscription-history", userId],
    queryFn: () => api.subscriptions.getHistory(),
    enabled: !!userId,
  });

  // Downgrade já contratado que ainda não entrou em vigor. Precisa aparecer
  // no Dashboard: é o lugar onde o fornecedor acompanha o plano, e uma troca
  // agendada que ele não enxerga vira surpresa no vencimento (seção 81).
  const { data: scheduled = null } = useQuery({
    queryKey: ["my-scheduled-subscription", userId],
    queryFn: () => api.subscriptions.getScheduled(),
    enabled: !!userId,
  });

  const planLabel = subscription ? PLAN_LABELS[subscription.plan_id] || subscription.plan_id : null;
  const planPrice = subscription ? getPlanPrice(subscription.plan_id) : null;
  // "1 de ilimitado anúncios ativos" não é frase. Premium tem limite infinito.
  const adsLabel = adLimit === Infinity
    ? `${adsUsed} ${adsUsed === 1 ? "anúncio ativo" : "anúncios ativos"} · ilimitado no seu plano`
    : `${adsUsed} de ${formatAdLimit(adLimit)} anúncios ativos`;

  return (
    <Card className="mb-8 rounded-card border border-slate-200 shadow-none dark:border-slate-800">
      <CardContent className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wider text-slate-400 dark:text-slate-500 font-semibold">Gerenciar planos</p>

          {state === "none" && (
            <>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">Sem plano ativo</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">Escolha um plano para começar a anunciar no NEXAR.</p>
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">Anúncios ativos: 0</p>
            </>
          )}

          {state === "active" && (
            <>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <p className="text-lg font-bold text-slate-800 dark:text-slate-100">Plano {planLabel}</p>
                <Badge className="bg-orange-100 text-xs text-orange-700 dark:bg-orange-500/15 dark:text-orange-400">Ativo</Badge>
              </div>
              {countdown && (
                <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mt-0.5">
                  <Clock className="w-3.5 h-3.5" /> {countdown}
                </p>
              )}
              {/* PRÓXIMA COBRANÇA (spec §22). Lê next_charge_at, gravado pelo
                  banco -- nunca calcula o dia 10 no navegador, que não conhece
                  o fuso oficial do produto. null = nada a cobrar (Básico, ou
                  assinatura já cancelada), e aí a linha some em vez de exibir
                  uma data inventada. */}
              {/* Sem pagamento online (C1, Resumo.md §231) nada renova nem é
                  cobrado: no lugar de "Próxima cobrança", a data em que o
                  período acaba. */}
              {subscription?.next_charge_at && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {PAID_CHECKOUT_AVAILABLE ? (
                    <>
                      Próxima cobrança em {formatDatePtBr(subscription.next_charge_at)}
                      {planPrice !== null && ` · R$ ${planPrice}`}
                    </>
                  ) : (
                    <>Válido até {formatDatePtBr(subscription.expires_at)} · renovação online em preparação</>
                  )}
                </p>
              )}
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {adsLabel}
              </p>
            </>
          )}

          {/* Assinatura interrompida por falha de pagamento (spec §11/§17).
              Nada no banco produz este status hoje -- não há cobrança para
              falhar --, mas o cartão já sabe exibi-lo para que o gateway
              futuro não precise mexer na UI junto com o resto. */}
          {state === "suspended" && (
            <>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <p className="text-lg font-bold text-slate-800 dark:text-slate-100">Plano {planLabel}</p>
                <Badge className="bg-red-100 text-xs text-red-700 dark:bg-red-500/15 dark:text-red-400">Suspenso</Badge>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Não conseguimos confirmar o pagamento. Seus anúncios ficam suspensos até a
                regularização — nada foi apagado.
              </p>
            </>
          )}

          {state === "cancelled_active" && (
            <>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <p className="text-lg font-bold text-slate-800 dark:text-slate-100">Plano {planLabel}</p>
                <Badge className="border border-slate-300 bg-transparent text-xs text-slate-600 dark:border-slate-600 dark:text-slate-300">Cancelado</Badge>
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Ativo até {formatDatePtBr(subscription.expires_at)}
              </p>
              {countdown && (
                <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" /> {countdown}
                </p>
              )}
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
                Você continuará tendo acesso aos benefícios até essa data.
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {adsLabel}
              </p>
            </>
          )}

          {/* "Sem plano", não "Plano expirado" (spec §2 e §10): a assinatura
              encerrou, mas a conta continua, os dados continuam, e os anúncios
              estão SUSPENSOS -- não apagados. Dizer isso aqui evita o medo
              legítimo de que cancelar tenha destruído o trabalho da pessoa. */}
          {state === "expired" && (
            <>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-1">Sem plano ativo</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Sua assinatura do {planLabel} foi encerrada. Seus anúncios e produtos ficam
                suspensos até você assinar de novo — nada foi apagado.
              </p>
            </>
          )}
          {scheduled && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-card border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-xs text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              Em {formatDatePtBr(scheduled.started_at)} seu plano passa para{" "}
              <strong>{PLAN_LABELS[scheduled.plan_id]}</strong>
            </p>
          )}
        </div>

        <div className="flex gap-2 flex-wrap items-start">
          {state === "none" && (
            <Link to={`${createPageUrl("Planos")}?onboarding=1`}>
              <Button variant="outline" className="rounded-card">Escolher plano</Button>
            </Link>
          )}

          {state === "active" && (
            <>
              <Link to={`${createPageUrl("Planos")}?manage=1`}>
                <Button variant="outline" className="rounded-card">Mudar plano</Button>
              </Link>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" disabled={cancelling} className="rounded-card border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
                    {cancelling ? "Cancelando..." : "Cancelar plano"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Tem certeza que deseja cancelar seu plano?</AlertDialogTitle>
                    <AlertDialogDescription className="space-y-3">
                      <span className="block">
                        {subscription?.plan_id === "basico"
                          ? "Ao confirmar, seu plano gratuito será cancelado imediatamente."
                          : "Você continuará com acesso aos benefícios até o fim do período já pago. Não haverá renovação automática."}
                      </span>
                      {/* A frase acima promete que nada entra no lugar. Com uma
                          troca agendada isso só é verdade porque o cancelamento
                          agora apaga o agendamento junto (seção 116) -- e o
                          fornecedor precisa saber que está desfazendo as duas
                          coisas de uma vez, porque reativar não traz a troca de
                          volta. */}
                      {scheduled && (
                        <span className="block rounded-card border border-orange-200 bg-orange-50 px-3 py-2.5 text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                          A troca para <strong>{PLAN_LABELS[scheduled.plan_id]}</strong>, marcada para{" "}
                          {formatDatePtBr(scheduled.started_at)}, também será desfeita. Para trocar
                          de plano sem cancelar, use <strong>Mudar plano</strong>.
                        </span>
                      )}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {/* Prévia (seção 194): sem plano, tudo sai do ar. Só monta
                      com o diálogo aberto, então só consulta quando a pessoa
                      está de fato pensando em cancelar. */}
                  <PlanLimitsImpact
                    planId={null}
                    note={subscription?.plan_id === "basico"
                      ? "Nada é apagado: eles voltam quando você assinar um plano."
                      : `Isso acontece em ${formatDatePtBr(subscription?.expires_at)}, quando o período pago acaba. Nada é apagado: eles voltam quando você assinar um plano.`}
                  />
                  <AlertDialogFooter>
                    <AlertDialogCancel>Não, voltar</AlertDialogCancel>
                    <AlertDialogAction onClick={onCancel} className="bg-red-500 hover:bg-red-600">
                      Sim, cancelar plano
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          {state === "cancelled_active" && (
            <Button
              variant="outline"
              onClick={onReactivate}
              disabled={reactivating}
              className="rounded-card border-orange-300 font-semibold text-orange-700 hover:bg-orange-50 dark:border-orange-500/40 dark:text-orange-400 dark:hover:bg-orange-500/10"
            >
              {reactivating ? "Reativando..." : "Reativar assinatura"}
            </Button>
          )}

          {state === "expired" && (
            <Link to={`${createPageUrl("Planos")}?manage=1`}>
              <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white">Escolher novo plano</Button>
            </Link>
          )}

          {/* Suspenso por falha de pagamento leva ao mesmo lugar, mas com
              outro rótulo: a pessoa não precisa ESCOLHER plano -- ela já tem
              um -- precisa REGULARIZAR. Quando o gateway existir, este botão
              passa a apontar para a troca do método de pagamento. */}
          {state === "suspended" && (
            <Link to={`${createPageUrl("Planos")}?manage=1`}>
              <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white">Regularizar pagamento</Button>
            </Link>
          )}
        </div>
      </CardContent>

      {history.length > 0 && (
        <CardContent className="pt-0 pb-5">
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 flex items-center gap-1.5 select-none">
              <History className="w-3.5 h-3.5" /> Histórico de planos ({history.length})
            </summary>
            <div className="mt-3 space-y-2">
              {history.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 p-3 rounded-card bg-slate-50 dark:bg-slate-800/60 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-700 dark:text-slate-200 truncate">
                      Plano {PLAN_LABELS[item.plan_id] || item.plan_id}
                    </p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                      {formatDatePtBr(item.started_at)} → {Number.isFinite(new Date(item.expires_at).getTime()) ? formatDatePtBr(item.expires_at) : "sem vencimento"}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs shrink-0">
                    {SUBSCRIPTION_STATUS_LABELS[item.status] || item.status}
                  </Badge>
                </div>
              ))}
            </div>
          </details>
        </CardContent>
      )}
    </Card>
  );
}
