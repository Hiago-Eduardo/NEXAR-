import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/components/ui/use-toast";
import {
  Check,
  Zap,
  Star,
  Crown,
  TrendingUp,
  Users,
  Megaphone,
  Rocket,
  BadgeCheck,
} from "lucide-react";
import Footer from "../components/shared/Footer";
import PlanLimitsImpact from "@/components/shared/PlanLimitsImpact";
import { api } from "@/api/client";
import {
  PLAN_LABELS,
  PLAN_AD_LIMITS,
  PLAN_PRODUCT_LIMITS,
  PLAN_PRODUCT_IMAGE_LIMITS,
  PLAN_PRICES,
  formatAdLimit,
  formatProductLimit,
  classifyPlanChange,
  chargesNow,
  isPlanPurchasable,
  describePlanChangeError,
  PAID_PLAN_UNAVAILABLE_TITLE,
  formatBRL,
} from "@/lib/plans";
import { getSubscriptionState, hasUsableBenefits, formatDatePtBr } from "@/lib/subscription";
import { useAuth } from "@/lib/AuthContext";

/*
 * Os três planos antes usavam três famílias de cor (azul / esmeralda /
 * âmbar) e o Premium ainda tinha botão em degradê amber->orange. Era o
 * mesmo problema do CategoryGrid: cor decorativa sem significado, e nada
 * disso comunicava hierarquia de plano.
 *
 * Agora a hierarquia é feita por PESO, dentro da paleta do sistema:
 *   Básico       -> neutro, discreto (é a porta de entrada)
 *   Profissional -> laranja (é o recomendado, e o laranja é a cor de ação)
 *   Premium      -> tinta escura (o topo pesa mais que o recomendado)
 * Ver CONTEXTO.MD/Resumo.md seção 76.
 */
const TIER = {
  basico: {
    card: "border-slate-200 dark:border-slate-800",
    iconBox: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
    check: "text-slate-400 dark:text-slate-500",
    button:
      "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
  },
  profissional: {
    card: "border-orange-500 dark:border-orange-500",
    iconBox: "bg-orange-50 text-orange-500 dark:bg-orange-500/15 dark:text-orange-400",
    check: "text-orange-500",
    button: "bg-orange-500 text-white hover:bg-orange-600",
  },
  premium: {
    card: "border-slate-900 dark:border-slate-100",
    iconBox: "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900",
    check: "text-slate-900 dark:text-slate-100",
    button:
      "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white",
  },
};

/*
 * LISTAS REESCRITAS (seção 109). A versão anterior anunciava coisas que o
 * produto NÃO entrega, o que é risco comercial e não só texto ruim -- cada
 * item foi conferido contra o código antes de sair ou ficar:
 *
 * SAÍRAM POR SEREM FALSOS:
 *  - "Melhor posicionamento nas buscas" / "Destaque nas buscas":
 *    suppliers_public_list ordena por created_at desc. A busca não conhece
 *    plano. Nenhum dos dois existe.
 *  - "Suporte prioritário" / "Prioridade máxima no suporte": não existe
 *    suporte no produto -- a única menção é um "Em breve" em Configurações.
 *
 * SAÍRAM POR NÃO SEREM BENEFÍCIO DE PLANO (todo plano tem):
 *  - "Pausar e reativar anúncios": handleToggleAdStatus não consulta plano.
 *  - "Produtos e serviços no perfil": o gate isProfissional foi removido em
 *    18/09 (seções 66-70) -- o que varia é a QUANTIDADE, que agora está dita.
 *
 * SAÍRAM POR NÃO DIFERENCIAREM NADA:
 *  - "Cadastro da empresa", "Cadastro completo da empresa", "Perfil básico",
 *    "Gerenciamento completo dos anúncios".
 *  - "Renovação a cada 30 dias, cancele quando quiser": é condição
 *    comercial, não benefício, e já está dita abaixo da grade.
 *
 * ENTRARAM POR SEREM REAIS E NÃO ESTAREM EM LUGAR NENHUM:
 *  - Limite de produtos no catálogo e de fotos por produto. São os dois
 *    únicos limites além dos anúncios impostos por trigger no banco
 *    (enforce_product_catalog_rules / enforce_product_image_rules) e não
 *    apareciam na tela de vendas.
 *
 * Os números vêm das constantes de plans.js, nunca digitados: são o mesmo
 * valor que o banco enforce, então não há como a vitrine prometer um limite
 * e o produto entregar outro.
 *
 * As três listas têm a MESMA estrutura, linha a linha (anúncios / catálogo /
 * fotos / perfil / visibilidade). Isso é de design tanto quanto de conteúdo:
 * permite comparar os planos na horizontal e faz os três cartões terminarem
 * na mesma altura, acabando com o vão enorme que sobrava no Básico.
 */
const plans = [
  {
    id: "basico",
    name: "Básico",
    icon: Zap,
    price: PLAN_PRICES.basico,
    highlight: false,
    buttonLabel: "Começar grátis",
    features: [
      `${formatAdLimit(PLAN_AD_LIMITS.basico)} anúncio ativo`,
      `Até ${formatProductLimit(PLAN_PRODUCT_LIMITS.basico)} produtos no catálogo`,
      `${PLAN_PRODUCT_IMAGE_LIMITS.basico} foto por produto`,
      "Perfil da empresa e contato visíveis",
      "Aparece na busca do site",
    ],
  },
  {
    id: "profissional",
    name: "Profissional",
    icon: Star,
    price: PLAN_PRICES.profissional,
    highlight: "Mais escolhido",
    buttonLabel: "Assinar agora",
    features: [
      `Até ${formatAdLimit(PLAN_AD_LIMITS.profissional)} anúncios ativos`,
      `Até ${formatProductLimit(PLAN_PRODUCT_LIMITS.profissional)} produtos no catálogo`,
      `${PLAN_PRODUCT_IMAGE_LIMITS.profissional} fotos por produto`,
      "Descrição completa da empresa no perfil",
      "Prioridade na vitrine da página inicial",
    ],
  },
  {
    id: "premium",
    name: "Premium",
    icon: Crown,
    price: PLAN_PRICES.premium,
    highlight: false,
    buttonLabel: "Assinar Premium",
    features: [
      // Escrito por extenso em vez de derivado com um "s" no fim: o Premium é
      // o único plano com limite infinito hoje, e `${formatAdLimit(5)}s`
      // produziria "5s" no dia em que ele deixasse de ser.
      "Anúncios ativos ilimitados",
      "Produtos no catálogo ilimitados",
      `${PLAN_PRODUCT_IMAGE_LIMITS.premium} fotos por produto`,
      "Selo de empresa verificada",
      "Prioridade máxima na vitrine da página inicial",
    ],
  },
];

// Mesma regra dos planos: os quatro benefícios tinham uma cor cada
// (azul/esmeralda/roxo/âmbar). Agora o numeral é o que ordena a leitura.
const benefits = [
  {
    icon: TrendingUp,
    title: "Mais visibilidade online",
    description: "Sua empresa aparece para empreendedores buscando fornecedores ativamente.",
  },
  {
    icon: Users,
    title: "Conexão direta com clientes",
    description: "Receba contatos e pedidos de orçamento diretamente de quem tem interesse.",
  },
  {
    icon: Megaphone,
    title: "Divulgação da sua empresa",
    description: "Anuncie seus produtos e serviços para um público qualificado e segmentado.",
  },
  {
    icon: Rocket,
    title: "Crescimento do seu negócio",
    description: "Aumente suas vendas e expanda sua rede de clientes com a plataforma.",
  },
];

function PlanCard({ plan, index, currentPlanId, onChoose }) {
  const Icon = plan.icon;
  const tier = TIER[plan.id];
  const { isAuthenticated } = useAuth();
  const change = classifyPlanChange(currentPlanId, plan.id);
  const isCurrent = change === "same";
  // Plano pago sem contratação online (C1, Resumo.md §231): o banco recusa
  // com PAYMENT_REQUIRED; a tela não oferece o que não pode concluir.
  const unavailable = !isCurrent && !isPlanPurchasable(plan.id, currentPlanId);

  // Quem não tem conta nenhuma vai para o cadastro; os demais passam pelo
  // fluxo de confirmação em `onChoose` (ver handleChoose no componente pai).
  // NUNCA existe um link que contrate direto -- era assim que o
  // ?set_plan= concedia plano sem passar por lugar nenhum (seção 81).
  if (!isAuthenticated) {
    return (
      <PlanCardShell plan={plan} tier={tier} index={index} unavailable={unavailable}>
        <Link to={createPageUrl("Register")}>
          <Button className={`h-12 w-full rounded-card text-base font-bold ${tier.button}`}>
            {/* Sem contratação paga online, "Assinar agora" prometeria algo que
                o cadastro não entrega -- o botão leva só ao cadastro. */}
            {unavailable ? "Criar conta" : plan.buttonLabel}
          </Button>
        </Link>
      </PlanCardShell>
    );
  }

  if (unavailable) {
    return (
      <PlanCardShell plan={plan} tier={tier} index={index} unavailable>
        <Button
          disabled
          className="h-12 w-full rounded-card text-base font-bold bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
        >
          {PAID_PLAN_UNAVAILABLE_TITLE}
        </Button>
      </PlanCardShell>
    );
  }

  return (
    <PlanCardShell plan={plan} tier={tier} index={index} isCurrent={isCurrent}>
      <Button
        onClick={() => onChoose(plan)}
        disabled={isCurrent}
        className={`h-12 w-full rounded-card text-base font-bold ${
          isCurrent ? "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500" : tier.button
        }`}
      >
        {/* "Agendar mudança" saiu (seção 109): agendamento é vocabulário de
            sistema, e agora TODA troca de quem já paga vale no fim do ciclo --
            a palavra deixou de distinguir alguma coisa. Quem explica o "quando"
            é o alerta de confirmação, que é onde a pessoa está prestes a
            decidir. */}
        {isCurrent ? "Seu plano atual" : change === "downgrade" ? "Trocar de plano" : plan.buttonLabel}
      </Button>
    </PlanCardShell>
  );
}

function PlanCardShell({ plan, tier, index, isCurrent = false, unavailable = false, children }) {
  const Icon = plan.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.06, duration: 0.3 }}
      className={`relative flex flex-col overflow-hidden rounded-card border-2 bg-white dark:bg-slate-900 ${tier.card}`}
    >
      {/* O destaque é uma faixa no topo do cartão, não um `scale-105` + sombra
          colorida que desalinhava a grade inteira.

          A FAIXA OCUPA ESPAÇO NOS TRÊS CARTÕES, sempre -- quando não há nada a
          dizer, ela fica vazia. Antes só o Profissional tinha faixa, então ela
          empurrava o conteúdo dele para baixo e nome, preço, linha e lista
          ficavam em alturas DIFERENTES nos três cartões. Era o que mais
          atrapalhava a comparação: numa tabela de preços o olho lê na
          horizontal, e nada estava na mesma linha (seção 109). */}
      <div
        className={`py-1.5 text-center text-[11px] font-bold uppercase tracking-wider ${
          isCurrent
            ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
            : plan.highlight
              ? "bg-orange-500 text-white"
              : "bg-transparent"
        }`}
      >
        {/* &nbsp; garante a altura da faixa vazia sem precisar fixar px. */}
        {isCurrent ? "Plano atual" : plan.highlight || " "}
      </div>

      <div className="flex flex-1 flex-col p-7">
        <div className="mb-5 flex items-center gap-3">
          <span className={`flex h-11 w-11 items-center justify-center rounded-card ${tier.iconBox}`}>
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <h3 className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">
              {plan.name}
            </h3>
            <p className="text-xs text-slate-400 dark:text-slate-500">Para fornecedores</p>
          </div>
        </div>

        <div className="mb-6">
          {plan.price === 0 ? (
            <span className="font-display text-5xl font-black leading-none text-slate-900 dark:text-slate-50">
              Grátis
            </span>
          ) : (
            <div className="flex items-end gap-1">
              <span className="mb-1.5 text-lg font-semibold text-slate-400 dark:text-slate-500">R$</span>
              <span className="tnum font-display text-5xl font-black leading-none text-slate-900 dark:text-slate-50">
                {plan.price}
              </span>
              <span className="mb-1.5 text-sm text-slate-400 dark:text-slate-500">/mês</span>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {unavailable ? "Contratação online em preparação" : "Sem taxa de adesão"}
          </p>
        </div>

        <div className="mb-6 h-px bg-slate-200 dark:bg-slate-800" />

        {/* Respiro maior entre itens e dentro de cada linha: era space-y-2.5 +
            leading-snug, que numa lista de 9 itens virava um bloco cinza
            compacto demais para ler (seção 109). Com as listas reescritas em 5
            linhas paralelas, sobra espaço para o texto respirar. */}
        <ul className="mb-8 flex-1 space-y-3.5">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-3">
              <Check className={`mt-0.5 h-4 w-4 shrink-0 ${tier.check}`} strokeWidth={3} />
              <span className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {feature}
              </span>
            </li>
          ))}
        </ul>

        {children}
      </div>
    </motion.div>
  );
}

export default function Planos() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  // useSearchParams em vez de window.location.search -- convenção do
  // CLAUDE.md; o padrão antigo não reage a navegação client-side que só
  // troca a query (ex.: ir de /Planos para /Planos?manage=1 pelo menu).
  const [searchParams] = useSearchParams();
  const onboarding = searchParams.get("onboarding") === "1";
  const managing = searchParams.get("manage") === "1";
  const [currentSubscription, setCurrentSubscription] = useState(null);
  const [scheduledSubscription, setScheduledSubscription] = useState(null);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [confirming, setConfirming] = useState(false);

  // A assinatura vigente passou a ser carregada SEMPRE que há login, não só
  // no modo ?manage=1: é ela que decide se cada botão contrata, agenda ou
  // está desabilitado por já ser o plano atual (seção 81).
  const loadSubscriptions = React.useCallback(() => {
    if (!isAuthenticated) return;
    api.subscriptions.getCurrent().then(setCurrentSubscription).catch(() => setCurrentSubscription(null));
    api.subscriptions.getScheduled().then(setScheduledSubscription).catch(() => setScheduledSubscription(null));
  }, [isAuthenticated]);

  useEffect(() => { loadSubscriptions(); }, [loadSubscriptions]);

  const currentPlanState = getSubscriptionState(currentSubscription);
  const showCurrentPlanBanner = managing && (currentPlanState === "active" || currentPlanState === "cancelled_active");
  // Só conta como "plano atual" o que realmente dá benefício agora.
  const currentPlanId = hasUsableBenefits(currentSubscription) ? currentSubscription.plan_id : null;
  const pendingChange = pendingPlan ? classifyPlanChange(currentPlanId, pendingPlan.id) : null;
  // Plano pago só chega até aqui com o checkout ligado (isPlanPurchasable).
  const isCheckout = (pendingPlan?.price ?? 0) > 0;

  // NINGUÉM passa mais pela tela de Pagamento a partir daqui: a data oficial
  // de cobrança é o dia 10 (spec §4), e nem a primeira assinatura nem o
  // upgrade cobram no ato. Toda troca passa pelo mesmo alerta de confirmação,
  // que é onde o fornecedor lê quando a mudança vale e quando ela é cobrada.
  //
  // chargesNow() hoje devolve sempre false -- a chamada continua aqui, e não
  // foi apagada, porque é este o ponto onde o gateway futuro vai reintroduzir
  // o desvio para o cadastro do método de pagamento.
  const handleChoose = (plan) => {
    const change = classifyPlanChange(currentPlanId, plan.id);
    if (change === "same") return;
    if (!isPlanPurchasable(plan.id, currentPlanId)) {
      toast({ title: PAID_PLAN_UNAVAILABLE_TITLE, description: describePlanChangeError({ message: "PAYMENT_REQUIRED" }) });
      return;
    }
    if (chargesNow(change, plan.price)) {
      navigate(`${createPageUrl("Pagamento")}?plan=${plan.id}`);
      return;
    }
    setPendingPlan(plan);
  };

  const confirmChange = async () => {
    if (!pendingPlan) return;
    setConfirming(true);
    try {
      if (isCheckout) {
        // Plano pago: a cobrança é feita na tela de Pagamento do NEXAR
        // (§239), que gera a fatura e mostra Pix/boleto/cartão. Nada é
        // ativado aqui -- o plano entra quando o webhook confirma (§232).
        navigate(`${createPageUrl("Pagamento")}?plan=${pendingPlan.id}`);
        return;
      }
      await api.subscriptions.subscribe(pendingPlan.id);
      loadSubscriptions();
      toast({
        title: pendingChange === "downgrade" ? "Troca confirmada" : "Plano ativado",
        description:
          pendingChange === "downgrade"
            ? `Você continua no ${PLAN_LABELS[currentPlanId]} até o vencimento. Depois disso o ${pendingPlan.name} entra no lugar.`
            : `Seu plano ${pendingPlan.name} já está ativo.`,
      });
      setPendingPlan(null);
    } catch (error) {
      toast({
        title: "Não foi possível alterar o plano",
        description: describePlanChangeError(error),
        variant: "destructive",
      });
    } finally {
      setConfirming(false);
    }
  };

  const handleCancelScheduled = async () => {
    try {
      await api.subscriptions.cancelScheduledChange();
      loadSubscriptions();
      toast({ title: "Troca desfeita", description: "Seu plano atual continua como está." });
    } catch (error) {
      toast({ title: "Não foi possível desfazer a troca", description: error.message, variant: "destructive" });
    }
  };
  const contextNote = onboarding
    ? "Escolha um plano agora ou pule esta etapa e faça isso quando quiser criar seu anúncio."
    : managing
      ? "Escolha o novo plano para atualizar sua assinatura."
      : null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-site px-6 py-12">
          <div className="label-mono mb-4 flex items-center gap-2 text-orange-600 dark:text-orange-400">
            <BadgeCheck className="h-3.5 w-3.5" />
            Planos para fornecedores
          </div>
          {/* leading-[1.05] -> leading-[1.15]: em peso 900 no tamanho md:text-5xl
              as duas linhas do título quase se encostavam. O tracking-tight
              fica (é a assinatura da face de display, seção 71); o que estava
              apertado demais era a entrelinha, não a letra. */}
          <h1 className="max-w-3xl font-display text-4xl font-black leading-[1.15] tracking-tight text-slate-900 dark:text-slate-50 md:text-5xl">
            Escolha o plano ideal para anunciar sua empresa
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-slate-500 dark:text-slate-400">
            Aumente sua visibilidade e alcance mais clientes anunciando na plataforma.
          </p>

          {/* Avisos de contexto: antes eram texto solto em esmeralda (que
              lia como "sucesso"); agora é um bloco laranja, coerente com o
              resto do sistema. */}
          {contextNote && (
            <div className="mt-6 inline-flex items-center gap-2 rounded-card border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm font-medium text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
              {contextNote}
            </div>
          )}
          {showCurrentPlanBanner && (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Plano atual:{" "}
              <strong className="text-slate-900 dark:text-slate-100">
                {PLAN_LABELS[currentSubscription.plan_id]}
              </strong>
              {Number.isFinite(new Date(currentSubscription.expires_at).getTime()) && (
                <> — ativo até {formatDatePtBr(currentSubscription.expires_at)}</>
              )}
            </p>
          )}
        </div>
      </header>

      {/* <div>, não <main>: o Layout já fornece o landmark main (ver Suppliers.jsx e seção 107). */}
      <div className="mx-auto max-w-site px-6 py-10">
        {/* Troca já confirmada: precisa ficar visível e ser reversível --
            senão o fornecedor não tem como saber que vai trocar de plano no
            vencimento, nem como desistir.
            A palavra "agendada" saiu do texto voltado ao usuário (seção 109);
            ela descreve o mecanismo, não o que aconteceu do ponto de vista de
            quem confirmou uma troca. */}
        {scheduledSubscription && (
          <div className="mb-6 flex flex-col gap-3 rounded-card border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Troca confirmada: em{" "}
              <strong className="text-slate-900 dark:text-slate-50">
                {formatDatePtBr(scheduledSubscription.started_at)}
              </strong>{" "}
              seu plano passa para{" "}
              <strong className="text-slate-900 dark:text-slate-50">
                {PLAN_LABELS[scheduledSubscription.plan_id]}
              </strong>
              , e a cobrança acontece nessa data.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCancelScheduled}
              className="shrink-0 rounded-card font-semibold"
            >
              Desfazer troca
            </Button>
          </div>
        )}

        <div className="mb-10 grid items-stretch gap-5 md:grid-cols-3">
          {plans.map((plan, index) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              index={index}
              currentPlanId={currentPlanId}
              onChoose={handleChoose}
            />
          ))}
        </div>

        {onboarding && (
          <div className="mb-10 text-center">
            <Link
              to={createPageUrl("Dashboard")}
              className="text-sm font-semibold text-slate-500 underline underline-offset-4 transition-colors hover:text-orange-600 dark:text-slate-400 dark:hover:text-orange-400"
            >
              Pular por enquanto
            </Link>
          </div>
        )}

        <p className="mb-16 text-center text-sm text-slate-400 dark:text-slate-500">
          Todos os planos incluem acesso à plataforma. Cancele quando quiser.
        </p>

        {/* Por que anunciar */}
        <section className="mb-16">
          <div className="mb-8 max-w-xl">
            <h2 className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50">
              Por que anunciar aqui?
            </h2>
            <p className="mt-2 text-slate-500 dark:text-slate-400">
              Micro empreendedores buscam fornecedores confiáveis todos os dias.
            </p>
          </div>

          <div className="grid gap-px overflow-hidden rounded-card border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800 sm:grid-cols-2 lg:grid-cols-4">
            {benefits.map((benefit, index) => {
              const Icon = benefit.icon;
              return (
                <motion.div
                  key={benefit.title}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: index * 0.06, duration: 0.3 }}
                  className="bg-white p-6 dark:bg-slate-900"
                >
                  <div className="mb-4 flex items-center gap-3">
                    <span className="tnum font-display text-3xl font-black leading-none text-orange-500">
                      {index + 1}
                    </span>
                    <span className="flex h-9 w-9 items-center justify-center rounded-card bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400">
                      <Icon className="h-4 w-4" />
                    </span>
                  </div>
                  <h3 className="mb-1.5 font-display font-extrabold text-slate-900 dark:text-slate-50">
                    {benefit.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                    {benefit.description}
                  </p>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* CTA final -- só faz sentido pra quem ainda não tem conta; quem já
            está logado já viu os botões de assinar/trocar de plano acima. */}
        {!isAuthenticated && (
          <section className="relative overflow-hidden rounded-card bg-slate-950 px-8 py-14 text-center">
            <div className="absolute inset-x-0 top-0 h-1 bg-orange-500" />
            <h2 className="font-display text-3xl font-black tracking-tight text-white md:text-4xl">
              Pronto para crescer?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-400">
              Comece a anunciar e receba pedidos de orçamento de quem já está procurando o que
              você vende.
            </p>
            <Link to={createPageUrl("Register")} className="mt-8 inline-block">
              <Button className="h-12 rounded-card bg-orange-500 px-8 text-base font-bold text-white hover:bg-orange-600">
                Criar conta gratuitamente
              </Button>
            </Link>
          </section>
        )}
      </div>

      {/* Confirmação obrigatória. Antes NÃO EXISTIA: clicar num plano já
          contratava (seção 81). O texto muda conforme a troca seja imediata
          ou agendada, para o fornecedor saber exatamente o que vai acontecer
          e quando -- inclusive que o downgrade não devolve dias pagos. */}
      <AlertDialog open={!!pendingPlan} onOpenChange={(open) => !open && setPendingPlan(null)}>
        {/* ESPAÇAMENTO DESTE DIÁLOGO (seção 111).
            Os padrões do shadcn são feitos para uma pergunta curta de uma
            linha ("Tem certeza?"), não para um aviso de quatro parágrafos que
            a pessoa precisa LER antes de assumir uma cobrança: AlertDialogHeader
            vem com space-y-2 (8px entre título e texto) e AlertDialogDescription
            com text-sm, cuja entrelinha é 20px para uma fonte de 14px. Somado
            ao meu space-y-2 entre os blocos, o aviso virava um bloco cinza
            compacto. Aqui tudo é afrouxado de propósito -- este é o texto mais
            importante da tela. */}
        <AlertDialogContent className="rounded-card p-7">
          <AlertDialogHeader className="space-y-3">
            <AlertDialogTitle className="font-display text-xl font-extrabold leading-snug">
              {isCheckout
                ? `Contratar o plano ${pendingPlan?.name}?`
                : pendingChange === "downgrade"
                ? `Trocar para o ${pendingPlan?.name} no dia 10?`
                : pendingChange === "upgrade"
                  ? `Subir para o ${pendingPlan?.name} agora?`
                  : `Ativar o plano ${pendingPlan?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3.5 text-sm leading-relaxed">
              {isCheckout ? (
                <>
                  <span className="block">
                    Você vai para a página de pagamento do Asaas para pagar{" "}
                    <strong>{formatBRL(pendingPlan?.price)}</strong>.
                  </span>
                  <span className="block rounded-card border border-orange-200 bg-orange-50 px-4 py-3.5 leading-relaxed text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                    O plano <strong>{pendingPlan?.name}</strong> é ativado assim que o pagamento for
                    confirmado. Abrir a fatura não ativa nada.
                  </span>
                </>
              ) : pendingChange === "downgrade" ? (
                <>
                  <span className="block">
                    Você continua no <strong>{PLAN_LABELS[currentPlanId]}</strong> e mantém todos
                    os benefícios até{" "}
                    <strong>{formatDatePtBr(currentSubscription?.expires_at)}</strong> — nenhum dia
                    já pago é perdido.
                  </span>
                  <span className="block">
                    A troca para o <strong>{pendingPlan?.name}</strong> acontece automaticamente
                    nessa data.
                  </span>
                  {/* As duas frases que o usuário pediu em destaque: o QUANDO da
                      mudança e o QUANDO da cobrança. Ficam num bloco à parte
                      porque são a razão de o alerta existir -- diluídas no
                      parágrafo, ninguém leria (seção 109). */}
                  <span className="block rounded-card border border-orange-200 bg-orange-50 px-4 py-3.5 leading-relaxed text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                    {pendingPlan?.price > 0 ? (
                      <>
                        <strong>Nada é cobrado agora.</strong> A cobrança de R$ {pendingPlan.price}
                        {" "}passa a valer a partir da próxima cobrança, sempre no dia 10.
                      </>
                    ) : (
                      <>
                        <strong>Nada é cobrado agora</strong>, e o {pendingPlan?.name} é gratuito —
                        sua assinatura atual simplesmente não será renovada.
                      </>
                    )}
                  </span>
                  <span className="block">
                    Mudou de ideia? Você pode desfazer esta troca no painel enquanto ela não
                    entrar em vigor.
                  </span>
                </>
              ) : pendingChange === "upgrade" ? (
                <>
                  {/* O upgrade é o caso em que mais gente se assusta achando
                      que vai ser cobrada duas vezes -- era o que acontecia até
                      a seção 109. As três frases respondem, nesta ordem, o que
                      a pessoa quer saber: quando vale, quanto custa agora, e o
                      que acontece com o que ela já pagou. */}
                  <span className="block">
                    O <strong>{pendingPlan?.name}</strong> passa a valer{" "}
                    <strong>imediatamente</strong> — os benefícios ficam disponíveis assim que
                    você confirmar.
                  </span>
                  <span className="block rounded-card border border-orange-200 bg-orange-50 px-4 py-3.5 leading-relaxed text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                    <strong>Nada é cobrado agora.</strong> O valor de R$ {pendingPlan?.price} passa
                    a valer na próxima cobrança, no <strong>dia 10</strong>.
                  </span>
                  <span className="block">
                    Você não perde o que já pagou no {PLAN_LABELS[currentPlanId]}: o período atual
                    continua valendo até{" "}
                    <strong>{formatDatePtBr(currentSubscription?.expires_at)}</strong>, agora com os
                    benefícios do {pendingPlan?.name}.
                  </span>
                </>
              ) : (
                <>
                  <span className="block">
                    O plano <strong>{pendingPlan?.name}</strong> passa a valer imediatamente
                    {pendingPlan?.price === 0 ? " e é gratuito." : "."}
                  </span>
                  {pendingPlan?.price > 0 && (
                    <span className="block rounded-card border border-orange-200 bg-orange-50 px-4 py-3.5 leading-relaxed text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                      <strong>Nada é cobrado agora.</strong> A primeira cobrança de R${" "}
                      {pendingPlan?.price} acontece no <strong>dia 10</strong>.
                    </span>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* O que acontece com anúncios e produtos (seção 194). Pela regra
              do banco, com nome. Fora do Description porque aquele é <p>. */}
          {pendingPlan && (
            <div className="mt-4">
              <PlanLimitsImpact
                planId={pendingPlan.id}
                enabled={isAuthenticated}
                note={pendingChange === "downgrade"
                  ? `Calculado pela situação de hoje; vale em ${formatDatePtBr(currentSubscription?.expires_at)}. Depois, você escolhe no painel quais ficam no ar.`
                  : null}
              />
            </div>
          )}
          {/* mt-7 + gap: o rodapé encostava no texto, e um botão que confirma
              cobrança precisa de separação do aviso que a justifica. */}
          <AlertDialogFooter className="mt-7 gap-2">
            <AlertDialogCancel className="h-11 rounded-card px-5">Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirmChange(); }}
              disabled={confirming}
              className="h-11 rounded-card bg-orange-500 px-5 font-bold text-white hover:bg-orange-600"
            >
              {confirming ? "Confirmando…" : isCheckout ? "Ir para o pagamento" : "Confirmar troca"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Footer />
    </div>
  );
}
