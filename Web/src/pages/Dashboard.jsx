import React, { useState, useEffect } from "react";
import { api } from "@/api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Eye, MessageSquare, CreditCard, Store, Plus, ChevronRight,
  TrendingUp, Star, Package, Pencil, Trash2, Pause, Play, Mail, Phone, FileText
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import PerformanceCharts from "../components/dashboard/PerformanceCharts";
import PlanManagerCard from "../components/dashboard/PlanManagerCard";
import ReviewsPanel from "../components/dashboard/ReviewsPanel";
import SwapSlotDialog from "@/components/shared/SwapSlotDialog";
import { useToast } from "@/components/ui/use-toast";
import { PLAN_LABELS, PLAN_PRICES, getPlanAdLimit, formatBRL } from "@/lib/plans";
import { hasUsableBenefits } from "@/lib/subscription";
import { useAuth } from "@/lib/AuthContext";
import { CATEGORY_LABELS } from "@/lib/categories";
import { getItemState, ITEM_STATE_LABELS, countItemStates, describeSuspension, planRuleErrorMessage } from "@/lib/itemStatus";

const AD_STATE_BADGE = {
  active: "border-orange-300 text-orange-600 dark:border-orange-500/40 dark:text-orange-400",
  paused: "border-slate-200 text-slate-400 dark:border-slate-700 dark:text-slate-500",
  suspended_plan_limit: "border-amber-300 text-amber-700 dark:border-amber-500/40 dark:text-amber-400",
  suspended_no_plan: "border-red-300 text-red-600 dark:border-red-500/40 dark:text-red-400",
};

const planLabels = PLAN_LABELS;
// Mesma escala de plano usada em Planos.jsx (seção 76): neutro -> laranja ->
// tinta escura. Antes era esmeralda/âmbar -- duas cores que não diziam nada
// sobre hierarquia de plano. Ver CONTEXTO.MD/Resumo.md seção 77.
const planColors = {
  basico: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
  profissional: "bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-400",
  premium: "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900",
};
// Quantos pedidos de orçamento aparecem antes do "ver todos".
const PEDIDOS_VISIVEIS = 5;

// Status do pedido de orçamento. "Novo" pede ação e leva a cor de destaque;
// respondido/fechado ficam neutros (mesma regra da seção 77).
const PEDIDO_STATUS = {
  pending: { label: "Novo", classe: "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-400" },
  replied: { label: "Respondido", classe: "border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400" },
  closed: { label: "Fechado", classe: "border-slate-200 text-slate-400 dark:border-slate-800 dark:text-slate-500" },
};

export default function Dashboard() {
  const { user, isLoadingAuth, authChecked } = useAuth();
  const [cancelingPlan, setCancelingPlan] = useState(false);
  const [reactivatingPlan, setReactivatingPlan] = useState(false);
  const [togglingAdId, setTogglingAdId] = useState(null);
  const [pedidoAberto, setPedidoAberto] = useState(null);
  const [verTodosPedidos, setVerTodosPedidos] = useState(false);
  const [mudandoPedidoId, setMudandoPedidoId] = useState(null);
  // Anúncio suspenso pelo limite que a pessoa quer pôr no ar (troca manual).
  const [swapTarget, setSwapTarget] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const navigate = useNavigate();
  // Painel é de FORNECEDOR. A NavBar só mostra "Meu painel" para ele, mas um
  // cliente que digitasse /Dashboard via "Sem plano ativo" e "Novo Anúncio"
  // -- um painel que não é dele (seção 165).
  const ehFornecedor = user?.role === "fornecedor" || user?.role === "admin";

  useEffect(() => {
    if (authChecked && !user) {
      api.auth.redirectToLogin("/Dashboard");
    } else if (authChecked && user && !ehFornecedor) {
      navigate(createPageUrl("Suppliers"), { replace: true });
    }
  }, [authChecked, user, ehFornecedor, navigate]);

  // Reconcilia expiracao de plano (e pausa automatica dos anuncios) toda vez que o
  // fornecedor abre o Dashboard. A validade real e sempre recalculada no backend.
  useEffect(() => {
    if (!user || !ehFornecedor) return;
    // .catch ANTES do .finally, e não é detalhe: sem ele, uma falha no sync
    // virava unhandled rejection -- o .finally rodava, o cache era invalidado,
    // a tela parecia normal e NADA dizia que a reconciliação não aconteceu.
    // Foi assim que o CHECK faltando em suppliers.status (seção 133) ficou
    // invisível: suspend_my_ads estourava, derrubava o sync inteiro, e o
    // Dashboard não mudava de aparência.
    api.subscriptions.sync().catch((erro) => {
      console.error("sync_my_subscription falhou:", erro?.message || erro);
    }).finally(() => {
      queryClient.invalidateQueries({ queryKey: ["my-subscription"] });
      queryClient.invalidateQueries({ queryKey: ["my-suppliers"] });
      // sync() e quem PROMOVE a troca agendada para ativa (passo (b) de
      // sync_my_subscription). No dia em que a troca entra em vigor, a
      // query do agendamento ja rodou em paralelo com o sync e trouxe a
      // linha ainda como 'scheduled' -- sem invalidar aqui, o cartao mostra
      // "Plano Profissional / Ativo" e, logo abaixo, "seu plano passa para
      // Profissional". Some so no F5.
      queryClient.invalidateQueries({ queryKey: ["my-scheduled-subscription"] });
    });
  }, [user, ehFornecedor, queryClient]);

  // REMOVIDO: o handler de `?set_plan=` (ver CONTEXTO.MD/Resumo.md seção 81).
  //
  // Ele lia o plano da QUERY STRING e chamava subscribe() direto, sem
  // validar o valor e sem nenhuma confirmação. A tela de Planos só gerava
  // esse link para o "basico", mas nada impedia alguém de digitar
  // /Dashboard?set_plan=premium no navegador e receber o plano mais caro de
  // graça -- a RPC aceitava os três planos.
  //
  // Agora toda contratação passa por uma confirmação explícita em
  // Planos.jsx (gratuito) ou por Pagamento.jsx (pago). Não recriar este
  // atalho: conceder plano a partir de parâmetro de URL é falha de cobrança,
  // não conveniência.

  const { data: suppliers = [], isLoading: loadingSuppliers } = useQuery({
    queryKey: ["my-suppliers", user?.email],
    queryFn: () => api.entities.Supplier.filter({ created_by: user.email }),
    enabled: !!user,
  });

  const { data: subscription = null } = useQuery({
    queryKey: ["my-subscription", user?.id],
    queryFn: () => api.subscriptions.getCurrent(),
    enabled: !!user,
  });

  // Os ids na chave: excluir ou criar um anúncio muda de quais anúncios os
  // pedidos vêm, e a chave antiga (só o e-mail) mantinha a lista velha.
  const supplierIds = suppliers.map((s) => s.id);
  const { data: contacts = [] } = useQuery({
    queryKey: ["my-contacts", user?.email, supplierIds],
    queryFn: async () => {
      if (!supplierIds.length) return [];
      const all = await Promise.all(
        supplierIds.map((id) => api.entities.ContactRequest.filter({ supplier_id: id }))
      );
      // MAIS RECENTE PRIMEIRO. A lista era a concatenação por anúncio, na
      // ordem que o banco devolvesse -- o "Contatos Recentes" mostrava 5
      // pedidos quaisquer, não os 5 últimos (seção 162).
      return all.flat().sort(
        (a, b) => new Date(b.created_at || b.created_date) - new Date(a.created_at || a.created_date)
      );
    },
    enabled: supplierIds.length > 0,
  });

  const { data: reviews = [] } = useQuery({
    queryKey: ["my-reviews", user?.email],
    queryFn: async () => {
      if (!suppliers.length) return [];
      const all = await Promise.all(
        suppliers.map((s) => api.entities.Review.filter({ supplier_id: s.id }))
      );
      return all.flat();
    },
    enabled: suppliers.length > 0,
  });

  // Visualizações e contatos (leads) reais, agregados no banco (ver my_ad_view_counts /
  // my_lead_counts em supabase/rls-policies.sql) — nada aqui é estimado ou calculado
  // a partir de reviews/quantidade de anúncios.
  const { data: viewCountsRaw = [] } = useQuery({
    queryKey: ["my-ad-view-counts", user?.id],
    queryFn: () => api.metrics.getMyAdViewCounts(),
    enabled: !!user,
  });

  const { data: leadCountsRaw = [] } = useQuery({
    queryKey: ["my-lead-counts", user?.id],
    queryFn: () => api.metrics.getMyLeadCounts(),
    enabled: !!user,
  });

  const viewCountBySupplier = Object.fromEntries(
    viewCountsRaw.map((row) => [row.supplier_id, Number(row.views) || 0])
  );
  const leadCountBySupplier = Object.fromEntries(
    leadCountsRaw.map((row) => [row.supplier_id, Number(row.leads) || 0])
  );
  const totalViews = suppliers.reduce((sum, s) => sum + (viewCountBySupplier[s.id] || 0), 0);
  const totalLeads = suppliers.reduce((sum, s) => sum + (leadCountBySupplier[s.id] || 0), 0);

  const avgRating = reviews.length
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : "—";

  // Plano da conta do fornecedor: fonte da verdade para liberar/bloquear a criação de
  // anúncios é sempre a tabela subscriptions (via api.subscriptions), nunca user_metadata.
  const userHasPlan = hasUsableBenefits(subscription);
  const planId = userHasPlan ? subscription.plan_id : null;
  const adLimit = getPlanAdLimit(planId);
  const activeSuppliers = suppliers.filter((s) => (s.status || "active") === "active");
  const adStates = countItemStates(suppliers);
  const adsUsed = activeSuppliers.length;
  // Uma assinatura por conta, não por anúncio -- nunca somar PLAN_PRICES[s.plan] por
  // fornecedor.suppliers (multiplicaria o valor pago pelo número de anúncios ativos).
  const totalSpent = PLAN_PRICES[planId] || 0;

  // Os seis cartões tinham uma cor cada (azul/roxo/esmeralda/âmbar/laranja/
  // rosa) -- decoração sem significado: nenhuma delas dizia nada sobre a
  // métrica. Unificados; o que diferencia é o número, que é o dado.
  const stats = [
    { label: "Anúncios ativos", value: activeSuppliers.length, icon: Store },
    { label: "Visualizações (total)", value: totalViews, icon: Eye },
    { label: "Contatos recebidos (total)", value: totalLeads, icon: MessageSquare },
    { label: "Avaliações", value: reviews.length, icon: Star },
    { label: "Nota média", value: avgRating, icon: TrendingUp },
    // "/mês" no RÓTULO, não no número: "R$ 99,00/mês" em text-2xl não cabe
    // em meio cartão no celular (o espaço depois de R$ é inseparável) e a
    // página ganhava rolagem lateral (seção 162).
    { label: "Gasto mensal com planos", value: formatBRL(totalSpent) || "R$ 0,00", icon: CreditCard },
  ];

  const handleDelete = async (supplierId) => {
    try {
      await api.entities.Supplier.delete(supplierId);
      queryClient.invalidateQueries({ queryKey: ["my-suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["my-ad-view-counts"] });
      queryClient.invalidateQueries({ queryKey: ["my-lead-counts"] });
      queryClient.invalidateQueries({ queryKey: ["my-daily-stats"] });
      queryClient.invalidateQueries({ queryKey: ["my-reviews"] });
      toast({ title: "Anúncio excluído" });
    } catch (error) {
      // 23503: algo no banco ainda aponta para o anúncio e a chave
      // estrangeira não é em cascata. A mensagem do Postgres ("violates
      // foreign key constraint...") não diz o que fazer; pausar diz.
      toast({
        title: "Não foi possível excluir o anúncio",
        description: error.code === "23503"
          ? "Este anúncio tem registros ligados a ele e não pode ser excluído. Você pode pausá-lo para tirá-lo do site."
          : error.message || "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    }
  };

  const novosPedidos = contacts.filter((c) => !PEDIDO_STATUS[c.status] || c.status === "pending").length;

  const handlePedidoStatus = async (contact, status) => {
    setMudandoPedidoId(contact.id);
    try {
      await api.contactRequests.setStatus(contact.id, status);
      queryClient.invalidateQueries({ queryKey: ["my-contacts"] });
    } catch (error) {
      toast({
        title: "Não foi possível atualizar o pedido",
        description: /could not find the function|PGRST202/i.test(error.message || "")
          ? "Esta função ainda não está disponível. Tente de novo mais tarde."
          : error.message,
        variant: "destructive",
      });
    } finally {
      setMudandoPedidoId(null);
    }
  };

  const handleCancelPlan = async () => {
    setCancelingPlan(true);
    try {
      await api.subscriptions.cancel();
      queryClient.invalidateQueries({ queryKey: ["my-subscription"] });
      queryClient.invalidateQueries({ queryKey: ["my-subscription-history"] });
      // O cancelamento agora apaga a troca agendada no banco (ver
      // supabase/cancel-clears-scheduled-change.sql). Sem invalidar esta
      // chave, o aviso "Em 20/10 seu plano passa para X" fica na tela
      // depois de a troca ter deixado de existir.
      queryClient.invalidateQueries({ queryKey: ["my-scheduled-subscription"] });
      toast({ title: "Plano cancelado", description: "Você continuará com acesso aos benefícios até o fim do período contratado." });
    } catch (error) {
      toast({ title: "Não foi possível cancelar o plano", description: error.message, variant: "destructive" });
    } finally {
      setCancelingPlan(false);
    }
  };

  const handleReactivatePlan = async () => {
    setReactivatingPlan(true);
    try {
      await api.subscriptions.reactivate();
      queryClient.invalidateQueries({ queryKey: ["my-subscription"] });
      queryClient.invalidateQueries({ queryKey: ["my-subscription-history"] });
      toast({ title: "Assinatura reativada" });
    } catch (error) {
      toast({ title: "Não foi possível reativar o plano", description: error.message, variant: "destructive" });
    } finally {
      setReactivatingPlan(false);
    }
  };

  const handleToggleAdStatus = async (supplier) => {
    // SUSPENSO NÃO ALTERNA. Suspensão é do sistema (falta de plano OU limite
    // do plano), não do fornecedor, e o banco recusa a reativação
    // (AD_SUSPENDED, plan-limits-hardening.sql). Barrar aqui troca o erro cru
    // por uma frase que diz o que fazer -- e o que fazer depende do motivo.
    if (supplier.status === "suspended") {
      toast(describeSuspension(supplier, "anúncio"));
      return;
    }
    const nextStatus = (supplier.status || "active") === "active" ? "paused" : "active";
    setTogglingAdId(supplier.id);
    try {
      await api.entities.Supplier.update(supplier.id, { status: nextStatus });
      queryClient.invalidateQueries({ queryKey: ["my-suppliers"] });
      toast({ title: nextStatus === "active" ? "Anúncio ativado" : "Anúncio pausado" });
    } catch (error) {
      const message = error.message || "";
      toast({
        title: "Não foi possível atualizar o anúncio",
        description: planRuleErrorMessage(message, "anúncio") || message,
        variant: "destructive",
      });
    } finally {
      setTogglingAdId(null);
    }
  };

  const createAdUrl = userHasPlan
    ? createPageUrl("AdEditor")
    : `${createPageUrl("Planos")}?onboarding=1`;

  const handleCreateAdClick = () => {
    if (!userHasPlan) {
      toast({
        title: "Plano necessário",
        description: "Você precisa de um plano ativo para criar anúncios.",
      });
    }
  };

  if (isLoadingAuth || !user || !ehFornecedor) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-orange-500 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-site mx-auto px-6 py-8">
        {/* Welcome */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-50">Dashboard</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">Gerencie seus anúncios e acompanhe seus resultados</p>
          </div>
          {/* flex-wrap: no celular os três botões não cabem numa linha e a
              página ganhava rolagem lateral (440px numa tela de 390). */}
          <div className="flex flex-wrap gap-3">
            <Link to={createPageUrl("Catalogo")}>
              <Button variant="outline" className="rounded-card border-slate-200 dark:border-slate-700 gap-2">
                <Package className="w-4 h-4" /> Catálogo
              </Button>
            </Link>
            <Link to={createPageUrl("Pagamento")}>
              <Button variant="outline" className="rounded-card border-slate-200 dark:border-slate-700 gap-2">
                <CreditCard className="w-4 h-4" /> Pagamento
              </Button>
            </Link>
            <Link to={createAdUrl} onClick={handleCreateAdClick}>
              <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white gap-2">
                <Plus className="w-4 h-4" /> Novo Anúncio
              </Button>
            </Link>
          </div>
        </div>

        <PlanManagerCard
          userId={user.id}
          subscription={subscription}
          adsUsed={adsUsed}
          adLimit={adLimit}
          onCancel={handleCancelPlan}
          onReactivate={handleReactivatePlan}
          cancelling={cancelingPlan}
          reactivating={reactivatingPlan}
        />

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {stats.map((s, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
              <div className="h-full rounded-card border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-card bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400">
                  <s.icon className="h-4 w-4" />
                </div>
                <div className="tnum font-display text-2xl font-black text-slate-900 dark:text-slate-50">
                  {s.value}
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{s.label}</div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Performance Charts */}
        <PerformanceCharts userId={user.id} hasSuppliers={suppliers.length > 0} />

        {/* Announcements */}
        <Card className="mb-6 rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="w-5 h-5 text-slate-400 dark:text-slate-500" />
              Meus Anúncios
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingSuppliers ? (
              // Sem isto, a tela piscava "Você ainda não tem anúncios" (ou o
              // convite para ver planos) antes de a lista chegar.
              <div className="space-y-3" aria-busy="true">
                {[1, 2].map((i) => <div key={i} className="h-20 rounded-card bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
              </div>
            ) : suppliers.length === 0 ? (
              userHasPlan ? (
                <div className="text-center py-12">
                  <Store className="w-12 h-12 text-slate-200 dark:text-slate-700 mx-auto mb-3" />
                  <p className="text-slate-500 dark:text-slate-400 mb-4">Você ainda não tem anúncios</p>
                  <Link to={createAdUrl} onClick={handleCreateAdClick}>
                    <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white">
                      <Plus className="w-4 h-4 mr-2" /> Criar Primeiro Anúncio
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="text-center py-12">
                  <Store className="w-12 h-12 text-slate-200 dark:text-slate-700 mx-auto mb-3" />
                  <p className="text-slate-500 dark:text-slate-400 mb-1">Você ainda não possui anúncios.</p>
                  <p className="text-slate-400 dark:text-slate-500 text-sm mb-4">
                    Escolha um plano para começar a divulgar seus produtos e serviços no NEXAR.
                  </p>
                  <Link to={`${createPageUrl("Planos")}?onboarding=1`}>
                    <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white">Ver planos</Button>
                  </Link>
                </div>
              )
            ) : (
              <div className="space-y-3">
                {(adStates.suspended_plan_limit > 0 || adStates.suspended_no_plan > 0) && (
                  <p className="text-sm text-slate-600 dark:text-slate-300 rounded-card border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 px-4 py-3">
                    {adStates.suspended_plan_limit > 0 && (
                      <>
                        {adStates.suspended_plan_limit === 1
                          ? "1 anúncio está suspenso porque seu plano não comporta todos."
                          : `${adStates.suspended_plan_limit} anúncios estão suspensos porque seu plano não comporta todos.`}
                        {" "}Eles voltam sozinhos, por ordem de criação, quando houver vaga no plano — ou
                        escolha agora qual fica no ar com <strong>Colocar no ar</strong>.{" "}
                      </>
                    )}
                    {adStates.suspended_no_plan > 0 && (
                      <>
                        {adStates.suspended_no_plan === 1
                          ? "1 anúncio está suspenso por falta de plano."
                          : `${adStates.suspended_no_plan} anúncios estão suspensos por falta de plano.`}{" "}
                      </>
                    )}
                    Nada foi apagado.{" "}
                    <Link to={`${createPageUrl("Planos")}?manage=1`} className="font-medium text-orange-600 hover:underline dark:text-orange-400">
                      Ver planos
                    </Link>
                  </p>
                )}
                {suppliers.map((supplier) => {
                  const supplierViews = viewCountBySupplier[supplier.id] || 0;
                  const supplierLeads = leadCountBySupplier[supplier.id] || 0;

                  return (
                    <div
                      key={supplier.id}
                      className="flex items-center gap-4 p-4 rounded-card bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                      {/* Logo */}
                      <div className="w-12 h-12 rounded-card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-center overflow-hidden flex-shrink-0">
                        {supplier.logo_url ? (
                          <img src={supplier.logo_url} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <Store className="w-6 h-6 text-slate-300 dark:text-slate-600" />
                        )}
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{supplier.business_name}</span>
                          <Badge className={`text-xs ${planColors[supplier.plan]}`}>
                            {planLabels[supplier.plan]}
                          </Badge>
                          {/* Quatro estados. "Suspenso" precisa ser
                              distinguível de "Pausado": pausado foi decisão do
                              fornecedor e ele desfaz num clique; suspenso é do
                              sistema e o clique não resolve. E os dois motivos
                              de suspensão pedem ações diferentes: sem plano ->
                              assinar; limite -> plano maior. */}
                          <Badge
                            variant="outline"
                            className={`text-xs ${AD_STATE_BADGE[getItemState(supplier)]}`}
                          >
                            {ITEM_STATE_LABELS[getItemState(supplier)]}
                          </Badge>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                          {CATEGORY_LABELS[supplier.category] || supplier.category} · {supplier.location}
                        </p>
                      </div>

                      {/* Metrics */}
                      <div className="hidden sm:flex items-center gap-6 text-center flex-shrink-0">
                        <div>
                          <div className="flex items-center gap-1 text-slate-600 dark:text-slate-300 justify-center">
                            <Eye className="w-3.5 h-3.5" />
                            <span className="text-sm font-semibold">{supplierViews}</span>
                          </div>
                          <span className="text-xs text-slate-400 dark:text-slate-500">visualiz.</span>
                        </div>
                        <div>
                          <div className="flex items-center gap-1 text-slate-600 dark:text-slate-300 justify-center">
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span className="text-sm font-semibold">{supplierLeads}</span>
                          </div>
                          <span className="text-xs text-slate-400 dark:text-slate-500">contatos</span>
                        </div>
                        <div>
                          <div className="flex items-center justify-center gap-1 text-orange-500">
                            <Star className="w-3.5 h-3.5" />
                            <span className="text-sm font-semibold">
                              {supplier.rating ? supplier.rating.toFixed(1) : "—"}
                            </span>
                          </div>
                          <span className="text-xs text-slate-400 dark:text-slate-500">avaliação</span>
                        </div>
                        {/* SAIU a coluna "R$ X/mês · plano": a assinatura é
                            UMA por conta, e o preço repetido em cada anúncio
                            dava a entender que cada um era cobrado à parte. */}
                      </div>

                      <div className="flex items-center gap-1 flex-shrink-0">
                        {getItemState(supplier) === "suspended_plan_limit" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSwapTarget({ id: supplier.id, name: supplier.business_name })}
                            className="h-8 rounded-card px-2.5 text-xs font-semibold"
                          >
                            Colocar no ar
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={togglingAdId === supplier.id || supplier.status === "suspended"}
                          onClick={() => handleToggleAdStatus(supplier)}
                          title={
                            supplier.status === "suspended"
                              ? ITEM_STATE_LABELS[getItemState(supplier)]
                              : (supplier.status || "active") === "active"
                                ? "Pausar anúncio"
                                : "Ativar anúncio"
                          }
                          aria-label={
                            supplier.status === "suspended"
                              ? `${ITEM_STATE_LABELS[getItemState(supplier)]}: ${supplier.business_name}`
                              : (supplier.status || "active") === "active"
                                ? `Pausar anúncio ${supplier.business_name}`
                                : `Ativar anúncio ${supplier.business_name}`
                          }
                          className="h-8 w-8 p-0 text-slate-400 hover:text-orange-500"
                        >
                          {(supplier.status || "active") === "active" ? (
                            <Pause className="w-4 h-4" />
                          ) : (
                            <Play className="w-4 h-4" />
                          )}
                        </Button>
                        <Link to={`${createPageUrl("AdEditor")}?id=${supplier.id}`}>
                          <Button variant="ghost" size="sm" aria-label={`Editar anúncio ${supplier.business_name}`} title="Editar anúncio" className="h-8 w-8 p-0 text-slate-400 hover:text-orange-500">
                            <Pencil className="w-4 h-4" />
                          </Button>
                        </Link>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" aria-label={`Excluir anúncio ${supplier.business_name}`} title="Excluir anúncio" className="text-slate-400 hover:text-red-500 h-8 w-8 p-0">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Excluir anúncio?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Tem certeza que deseja excluir <strong>{supplier.business_name}</strong>? O anúncio sai do site junto com as imagens da galeria. Os produtos continuam no seu Catálogo. Esta ação não pode ser desfeita.
                                {" "}Se quiser só tirar do ar por um tempo, use Pausar.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancelar</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDelete(supplier.id)} className="bg-red-500 hover:bg-red-600">
                                Excluir
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                        <Link to={`${createPageUrl("SupplierProfile")}?id=${supplier.id}`}>
                          <Button variant="ghost" size="sm" aria-label={`Ver anúncio ${supplier.business_name} no site`} title="Ver no site" className="text-slate-400 hover:text-slate-600 h-8 w-8 p-0">
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* PEDIDOS DE ORÇAMENTO (formulário "Solicitar orçamento" do anúncio).
            Este é o ÚNICO lugar onde o fornecedor vê os pedidos, e até a seção
            162 ele não tinha como respondê-los: a lista mostrava 5 pedidos
            quaisquer, a mensagem cortada em uma linha e NENHUM contato de quem
            pediu -- e-mail e telefone existiam no banco e não apareciam.
            Agora cada pedido abre com a mensagem inteira e os contatos
            clicáveis (mailto/tel).

            STATUS (seção 163): a policy de update de contact_requests só
            permite ao REMETENTE alterar o pedido, então o fornecedor nunca
            conseguia marcar como respondido. Agora marca pela RPC
            set_contact_request_status (supabase/contact-request-status.sql),
            que só mexe no status e só em pedidos dos anúncios dele. */}
        {contacts.length > 0 && (
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-slate-400 dark:text-slate-500" />
                Pedidos de Orçamento
                <span className="tnum ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {contacts.length}
                </span>
                {novosPedidos > 0 && (
                  <span className="tnum rounded-full bg-orange-500 px-2 py-0.5 text-xs font-semibold text-white">
                    {novosPedidos} {novosPedidos === 1 ? "novo" : "novos"}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {(verTodosPedidos ? contacts : contacts.slice(0, PEDIDOS_VISIVEIS)).map((contact) => {
                  const supplier = suppliers.find((s) => s.id === contact.supplier_id);
                  const data = contact.created_at || contact.created_date;
                  const aberto = pedidoAberto === contact.id;
                  const status = PEDIDO_STATUS[contact.status] ? contact.status : "pending";
                  return (
                    <li key={contact.id} className="rounded-card bg-slate-50 dark:bg-slate-800/60">
                      <button
                        type="button"
                        onClick={() => setPedidoAberto(aberto ? null : contact.id)}
                        aria-expanded={aberto}
                        className="flex w-full items-start gap-3 p-4 text-left"
                      >
                        <div className="w-8 h-8 rounded-full bg-orange-100 dark:bg-orange-500/15 flex items-center justify-center text-sm font-bold text-orange-600 dark:text-orange-400 flex-shrink-0">
                          {contact.sender_name?.[0]?.toUpperCase() || "?"}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm text-slate-800 dark:text-slate-100">{contact.sender_name || "Sem nome"}</span>
                            {supplier && (
                              <span className="text-xs text-slate-400 dark:text-slate-500">→ {supplier.business_name}</span>
                            )}
                            <span className="ml-auto flex items-center gap-2">
                              {data && (
                                <span className="text-xs text-slate-400 dark:text-slate-500">
                                  {new Date(data).toLocaleDateString("pt-BR")}
                                </span>
                              )}
                              <Badge variant="outline" className={`text-xs ${PEDIDO_STATUS[status].classe}`}>
                                {PEDIDO_STATUS[status].label}
                              </Badge>
                            </span>
                          </div>
                          <p className={`text-sm text-slate-600 dark:text-slate-300 mt-1 whitespace-pre-line ${aberto ? "" : "line-clamp-1"}`}>
                            {contact.message}
                          </p>
                          {!aberto && (
                            <span className="mt-1 inline-block text-xs font-medium text-orange-600 dark:text-orange-400">Ver pedido e contatos</span>
                          )}
                        </div>
                      </button>
                      {aberto && (
                        <div className="flex flex-wrap gap-2 px-4 pb-4 sm:pl-[3.75rem]">
                          {contact.sender_email && (
                            <a
                              href={`mailto:${contact.sender_email}?subject=${encodeURIComponent(`Orçamento${supplier ? ` — ${supplier.business_name}` : ""}`)}`}
                              className="inline-flex items-center gap-1.5 rounded-card bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600"
                            >
                              <Mail className="h-3.5 w-3.5" /> {contact.sender_email}
                            </a>
                          )}
                          {contact.sender_phone && (
                            <a
                              href={`tel:${contact.sender_phone.replace(/[^\d+]/g, "")}`}
                              className="inline-flex items-center gap-1.5 rounded-card border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
                            >
                              <Phone className="h-3.5 w-3.5" /> {contact.sender_phone}
                            </a>
                          )}
                          {!contact.sender_email && !contact.sender_phone && (
                            <span className="text-xs text-slate-500 dark:text-slate-400">Quem pediu não deixou e-mail nem telefone.</span>
                          )}
                          <span className="ml-auto flex flex-wrap gap-2">
                            {status !== "replied" && (
                              <Button type="button" size="sm" variant="outline" disabled={mudandoPedidoId === contact.id} onClick={() => handlePedidoStatus(contact, "replied")} className="rounded-card">
                                Marcar como respondido
                              </Button>
                            )}
                            {status !== "closed" && (
                              <Button type="button" size="sm" variant="ghost" disabled={mudandoPedidoId === contact.id} onClick={() => handlePedidoStatus(contact, "closed")} className="rounded-card text-slate-500 dark:text-slate-400">
                                Fechar
                              </Button>
                            )}
                            {status !== "pending" && (
                              <Button type="button" size="sm" variant="ghost" disabled={mudandoPedidoId === contact.id} onClick={() => handlePedidoStatus(contact, "pending")} className="rounded-card text-slate-500 dark:text-slate-400">
                                Reabrir
                              </Button>
                            )}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {contacts.length > PEDIDOS_VISIVEIS && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setVerTodosPedidos((v) => !v)}
                  className="mt-3 w-full text-sm text-slate-500 dark:text-slate-400"
                >
                  {verTodosPedidos ? "Mostrar menos" : `Ver todos os ${contacts.length} pedidos`}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Avaliações recebidas.
            O painel mostrava "Avaliações: N" e "Nota média: X" nos cartões do
            topo e mais nada -- o fornecedor via que EXISTIA uma avaliação e
            qual nota ela deu, mas não tinha onde ler o que escreveram nem
            quem escreveu. O texto só existia na página pública do anúncio,
            ou seja, ele precisaria navegar como visitante para ler a própria
            reputação. Ver CONTEXTO.MD/Resumo.md seção 102.

            Uma conta pode ter vários anúncios e a avaliação é POR ANÚNCIO,
            então cada item diz a qual anúncio se refere -- sem isso, uma
            crítica não teria como ser atribuída. */}
        {/* Resumo, filtro por anúncio e "Ver todas" -- seção 171. */}
        <ReviewsPanel reviews={reviews} suppliers={suppliers} />

        <SwapSlotDialog
          open={!!swapTarget}
          onOpenChange={(open) => !open && setSwapTarget(null)}
          kind="ad"
          noun="anúncio"
          target={swapTarget}
          candidates={suppliers
            .filter((s) => getItemState(s) === "active")
            .map((s) => ({ id: s.id, name: s.business_name }))}
          onSwapped={() => queryClient.invalidateQueries({ queryKey: ["my-suppliers"] })}
        />
      </div>
    </div>
  );
}