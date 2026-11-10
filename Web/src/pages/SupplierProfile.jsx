import React, { useEffect, useMemo, useRef } from "react";
import { api } from "@/api/client";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { getOrCreateVisitorSessionId } from "@/lib/visitorSession";
import { motion } from "framer-motion";
import {
  Star,
  MapPin,
  BadgeCheck,
  Phone,
  Mail,
  Globe,
  Package,
  Truck,
  ArrowLeft,
  MessageSquare,
  MessageCircle,
  Building2,
  Lock,
  ArrowRight,
  AlertTriangle,
  CalendarDays,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import ContactForm from "../components/supplier/ContactForm";
import AdGallery, { AdGalleryEmpty } from "../components/supplier/AdGallery";
import AdCompanyBanner, { AdBreadcrumb } from "../components/supplier/AdCompanyBanner";
import SupplierProductsSection from "../components/supplier/ProductsSection";
import CompanyProductsSection from "../components/supplier/CompanyProductsSection";
import ReviewForm from "../components/supplier/ReviewForm";
import ReviewList from "../components/supplier/ReviewList";
import { Panel, Stars } from "../components/shared/Panel";
import Footer from "../components/shared/Footer";
import { CATEGORY_LABELS } from "@/lib/categories";

// Era uma cópia local da lista; agora é a de categories.js (seção 213).
const categoryLabels = CATEGORY_LABELS;

// Selo de plano. Antes usava emoji (👑 / ⭐) e três famílias de cor
// diferentes (âmbar/esmeralda/cinza) -- ver CONTEXTO.MD/Resumo.md seção 73.
// Agora é uma escala só, do laranja sólido ao laranja suave.
//
// "basico" NÃO tem entrada aqui de propósito (decisão do usuário, seção 74):
// anunciar publicamente que o fornecedor está no plano mais barato deprecia
// o anúncio sem informar nada útil a quem compra. Sem entrada -> sem selo.
const PLAN_BADGE = {
  premium: { label: "Premium", className: "bg-orange-500 text-white" },
  profissional: {
    label: "Profissional",
    className: "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400",
  },
};

/** Linha de informação do anúncio. Os ícones antes vinham cada um de uma cor
 *  (azul/roxo/verde/âmbar/ciano) -- o arco-íris era um dos maiores indicadores
 *  de template. Agora todos usam o mesmo tratamento laranja discreto. */
function InfoRow({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {label}
        </div>
        <div className="break-words text-sm font-medium text-slate-800 dark:text-slate-100">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Um atributo comercial do anúncio -- a célula da grade de ícones do
 *  template (seção 142). Diferente do InfoRow acima, que é linha inteira:
 *  aqui são quatro em duas colunas, para caberem numa coluna estreita. */
function Atributo({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {label}
        </div>
        <div className="break-words text-sm font-semibold text-slate-800 dark:text-slate-100">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Cartão de contato da barra lateral -- a ação mais importante da página.
 *  Compartilhado pelas duas visões (anúncio e empresa), que antes repetiam
 *  o mesmo bloco com pequenas variações. */
function ContactPanel({ supplier, displayName, hasFullAccess, footer }) {
  const { user } = useAuth();
  const location = useLocation();
  // O DONO vendo o próprio anúncio via "Abrir chat" e o formulário de
  // orçamento endereçados a ele mesmo. A mensagem ia para ninguém: o banco
  // trata o dono como quem RESPONDE e não acha outro participante.
  const isOwnAd = !!user?.id && supplier.created_by === user.id;
  if (isOwnAd) {
    return (
      <Panel className="shadow-md" bodyClassName="p-5 space-y-3">
        <h2 className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">
          Este é o seu anúncio
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          É aqui que os clientes pedem orçamento e abrem conversa com você. As mensagens chegam em
          Mensagens, e os pedidos, no Dashboard.
        </p>
        <Link to={createPageUrl("Chat")} className="block">
          <Button className="h-11 w-full gap-2 rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600">
            <MessageCircle className="h-4 w-4" /> Ver minhas mensagens
          </Button>
        </Link>
        {footer}
      </Panel>
    );
  }

  const chatUrl = hasFullAccess
    ? createPageUrl("Chat") +
      // supplier_id = id do ANÚNCIO, nunca supplier.email. O e-mail é o de
      // CONTATO que o fornecedor digita, e pode não ser o do login dele --
      // a mensagem ia para um endereço sem conta e ninguém lia (seção 166).
      // O banco entrega ao dono do anúncio (trigger route_chat_message).
      `?supplier_id=${supplier.id}&with=${encodeURIComponent(displayName)}&ad_id=${supplier.id}`
    // "Entrar para conversar" levava ao CADASTRO, sem volta ao anúncio. Vai ao
    // Login com from= (ele tem link para criar conta).
    : `${createPageUrl("Login")}?from=${encodeURIComponent(location.pathname + location.search)}`;

  return (
    <Panel className="shadow-md" bodyClassName="p-5 space-y-4">
      <div>
        <h2 className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">
          Solicitar orçamento
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Envie uma mensagem para {displayName}
        </p>
      </div>

      {/* Botão principal em laranja: antes era quase-preto, o que fazia a
          ação central da página desaparecer no meio dos neutros. */}
      <Link to={chatUrl} className="block">
        <Button className="h-11 w-full gap-2 rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600">
          <MessageCircle className="h-4 w-4" />
          {hasFullAccess ? "Abrir chat" : "Entrar para conversar"}
        </Button>
      </Link>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        <span className="text-xs text-slate-400 dark:text-slate-500">ou</span>
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
      </div>

      <ContactForm supplierId={supplier.id} supplierName={displayName} />
      {footer}
    </Panel>
  );
}

/**
 * "Voltar" que respeita de onde a pessoa veio.
 *
 * Antes o destino era fixo: a visão de empresa mandava sempre para o anúncio
 * representante (`?id=<representative_supplier_id>`). Quem chegava pela aba
 * "Empresas" da busca nunca tinha aberto anúncio nenhum -- então o botão
 * dizia "Voltar ao anúncio" e jogava a pessoa DENTRO de um anúncio que ela
 * não conhecia, em vez de devolvê-la à busca (ver Resumo.md seção 86).
 *
 * `location.key === "default"` é o idioma do React Router para "esta é a
 * primeira entrada do histórico" -- ou seja, a pessoa colou a URL direto e
 * não há para onde voltar. Só nesse caso usamos o destino de reserva.
 */
function useSmartBack(fallbackUrl) {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHistory = location.key !== "default";

  return () => {
    if (hasHistory) navigate(-1);
    else navigate(fallbackUrl);
  };
}

/**
 * Capa + botão de voltar, comum às duas visões.
 *
 * VOLTOU A SER CAPA SIMPLES na seção 142. Entre as seções 139 e 142 ela foi
 * um carrossel, e a galeria do anúncio morava aqui -- numa faixa de 256px
 * com o conteúdo subindo 56px por cima. A galeria mudou para a coluna
 * principal (AdGallery.jsx), e toda a lógica de navegação saiu junto: setas,
 * pontos, teclado e imagens empilhadas viraram ~60 linhas sem uso.
 *
 * Deixar aquilo aqui seria pior que inútil -- daria a entender que existem
 * dois carrosséis na página.
 */
function Cover({ image, onBack, backLabel, tone }) {
  return (
    <div
      className={`relative h-52 overflow-hidden md:h-64 ${
        tone === "empresa"
          ? "bg-gradient-to-br from-orange-500 to-orange-700"
          : "bg-gradient-to-br from-orange-100 via-orange-50 to-slate-100 dark:from-orange-500/20 dark:via-slate-900 dark:to-slate-900"
      }`}
    >
      {image && <img src={image} alt="" className="h-full w-full object-cover" />}
      {/* Véu só na base, para o conteúdo sobreposto ter contraste garantido
          mesmo quando a capa é uma foto clara. */}
      <div className="absolute inset-0 bg-gradient-to-t from-slate-950/45 via-transparent to-transparent" />
      <div className="absolute left-0 right-0 top-0">
        <div className="mx-auto max-w-site px-6 py-5">
          <Button
            onClick={onBack}
            variant="secondary"
            className="h-9 gap-2 rounded-full bg-white/90 text-sm font-semibold text-slate-900 shadow-sm backdrop-blur-sm hover:bg-white"
          >
            <ArrowLeft className="h-4 w-4" />
            {backLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function SupplierProfile() {
  // useSearchParams (React Router) em vez de ler window.location.search direto:
  // aquela leitura não é reativa a navegação client-side (<Link>/history.pushState)
  // -- o componente não remonta ao trocar só o search da mesma rota, então "id"/"view"
  // ficavam presos no valor do primeiro render até um F5 ou remount forçarem a releitura.
  const [searchParams] = useSearchParams();
  const supplierId = searchParams.get("id");
  const view = searchParams.get("view") === "empresa" ? "empresa" : "anuncio";
  const companyUrl = `${createPageUrl("SupplierProfile")}?id=${supplierId}&view=empresa`;
  const adUrl = `${createPageUrl("SupplierProfile")}?id=${supplierId}`;

  // Telefone/email/site/entrega são informação de CONTATO -- visíveis pra
  // qualquer usuário com conta (não é sobre o plano do fornecedor, é sobre
  // o visitante ter feito login ou não). Sem login, o banco já nem devolve
  // essas colunas pra role anon (revoke por coluna em
  // supabase/contact-info-login-gate.sql) -- por isso o select tem que
  // pedir colunas explícitas nesse caso, '*' falharia inteiro.
  const { user } = useAuth();
  const hasFullAccess = !!user;

  // O ANÚNCIO INDIVIDUAL segue aberto a quem não tem conta -- é a isca do
  // produto (ver seção 84). O que muda é o caminho: sem sessão, a tabela
  // `suppliers` não é mais legível direto (anon-content-gate.sql), então a
  // leitura passa pela RPC supplier_public_by_id, que devolve só as colunas
  // públicas. Com sessão, continua lendo a tabela com '*' e recebendo também
  // telefone/email/site/entrega.
  const { data: supplier } = useQuery({
    queryKey: ["supplier", supplierId, hasFullAccess],
    queryFn: async () => {
      if (!hasFullAccess) return api.catalog.getSupplierById(supplierId);
      const rows = await api.entities.Supplier.filter({ id: supplierId }, undefined, undefined, '*');
      return rows?.[0] || null;
    },
    enabled: !!supplierId,
  });

  const plan = supplier?.plan || "basico";

  // Dono do anúncio. Só existe com sessão: a consulta deslogada usa
  // SUPPLIER_PUBLIC_COLUMNS, que NÃO inclui created_by (é coluna restrita a
  // anon). Logo `isOwner` é falso para o visitante por construção, não por
  // sorte -- e é isso que faz o estado vazio da galeria nunca aparecer para
  // quem não pode consertá-lo.
  const isOwner = !!user?.id && supplier?.created_by === user.id;

  // Selo "Verificado": sempre a assinatura real do DONO do anuncio (via RPC segura,
  // ver suppliers_verified_status em supabase/rls-policies.sql) -- nunca a assinatura
  // de quem esta vendo a pagina, e nunca supplier.plan/supplier.verified isolados.
  const { data: verifiedMap } = useQuery({
    queryKey: ["supplier-verified", supplier?.id],
    queryFn: () => api.verification.getForSuppliers([supplier.id]),
    enabled: !!supplier?.id,
  });
  const isVerified = !!verifiedMap?.[supplier?.id];

  // Galeria do anúncio (seção 139). A policy de leitura em supplier_images
  // só devolve imagens de anúncio visível -- ou do próprio dono --, então a
  // galeria de um anúncio suspenso não vaza por aqui.
  const { data: gallery = [] } = useQuery({
    queryKey: ["supplier-gallery", supplier?.id],
    queryFn: () => api.entities.SupplierImage.filter({ supplier_id: supplier.id }, "position"),
    // `view`, não `isCompanyView`: aquela const só é declarada mais abaixo, e
    // usá-la aqui seria ler um `const` antes da inicialização -- ReferenceError
    // em runtime, que o lint e o build NÃO pegam.
    enabled: !!supplier?.id && view !== "empresa",
  });

  // Sem `initialData: []` (era o que havia aqui): no React Query v5 ele deixa a
  // query em "success" desde o primeiro render, e quando o cache é esvaziado por
  // baixo do observer -- o que o AuthContext fazia em toda carga de página, ver
  // seção 103 -- a query volta ao valor inicial vazio e NÃO refaz a busca. O
  // resultado era uma lista de avaliações permanentemente vazia. Um default de
  // desestruturação dá a mesma proteção contra `undefined` sem mentir sobre o
  // estado da query.
  const {
    data: reviews = [],
    isError: isErrorReviews,
    error: reviewsError,
  } = useQuery({
    queryKey: ["reviews", supplierId],
    queryFn: () => api.entities.Review.filter({ supplier_id: supplierId }, "-created_date", 50),
    enabled: !!supplierId,
  });

  // --- Perfil publico da EMPRESA (dono do anuncio) ---------------------
  // Só busca quando o visitante realmente pede a visão de empresa (view=empresa),
  // pra não gerar RPCs extras em toda visita a um anúncio comum.
  // A visão de EMPRESA passou a exigir login (seção 84): é a visão agregada
  // da conta -- todos os anúncios, catálogo completo, reputação somada -- e
  // não a vitrine. As RPCs abaixo perderam o execute para `anon`, então as
  // queries só são habilitadas com sessão; sem ela a página mostra um muro.
  const companyGated = view === "empresa" && !hasFullAccess;
  const canLoadCompany = !!supplierId && view === "empresa" && hasFullAccess;

  // Precisa ficar ANTES do `if (!supplier) return ...` lá embaixo: hook
  // chamado depois de um return antecipado quebra as regras de hooks
  // ("rendered more hooks than during the previous render").
  const goBack = useSmartBack(view === "empresa" ? adUrl : createPageUrl("Suppliers"));

  const { data: companyProfile, isLoading: isLoadingCompanyProfile } = useQuery({
    queryKey: ["company-profile", supplierId],
    queryFn: () => api.company.getPublicProfile(supplierId),
    enabled: canLoadCompany,
  });

  // Todos os anúncios ativos da mesma empresa (mesmo created_by) — nunca
  // agrupados por nome/categoria/cidade, sempre pelo dono real (ver
  // company_public_suppliers em supabase/company-profile-rpc.sql).
  const { data: companySuppliers = [] } = useQuery({
    queryKey: ["company-suppliers", supplierId],
    queryFn: () => api.company.getPublicSuppliers(supplierId),
    enabled: canLoadCompany,
  });

  const companySupplierIds = useMemo(
    () => companySuppliers.map((s) => s.id),
    [companySuppliers]
  );

  // Catálogo completo da empresa (todos os produtos da conta, não só os
  // vinculados a este anúncio específico) -- ver company_public_products
  // em supabase/product-catalog.sql.
  const { data: companyProducts = [] } = useQuery({
    queryKey: ["company-products", supplierId],
    queryFn: () => api.company.getPublicProducts(supplierId),
    enabled: canLoadCompany,
  });

  // Reputação agregada: reviews de TODOS os anúncios da empresa, somadas só
  // para exibição — não mexe em como ReviewForm.jsx grava/recalcula
  // suppliers.rating/total_reviews por anúncio.
  const { data: companyReviews = [] } = useQuery({
    queryKey: ["company-reviews", companySupplierIds],
    queryFn: async () => {
      const perSupplier = await Promise.all(
        companySupplierIds.map((id) =>
          api.entities.Review.filter({ supplier_id: id }, "-created_date", 50)
        )
      );
      return perSupplier.flat();
    },
    enabled: canLoadCompany && companySupplierIds.length > 0,
  });

  const companyReviewsCount = companyReviews.length;
  const companyReviewsAvg = companyReviewsCount
    ? Math.round((companyReviews.reduce((sum, r) => sum + r.rating, 0) / companyReviewsCount) * 10) / 10
    : 0;

  // Nome comercial: business_name pode variar entre anúncios da mesma empresa,
  // então company_name (user_profiles, nível de conta) é a fonte preferida;
  // cai no anúncio de origem só como fallback (ver auditoria — seção 8).
  const companyName = companyProfile?.company_name || supplier?.business_name || "Empresa";
  // Telefone tratado como telefone DA EMPRESA (nunca pessoal) — mesma
  // preferência: user_profiles.phone, com fallback pro anúncio de origem.
  const companyPhone = companyProfile?.phone || supplier?.phone || "";
  const companySegmentLabel = companyProfile?.segment
    ? (CATEGORY_LABELS[companyProfile.segment] || companyProfile.segment)
    : "";

  // Visualização real da página pública do anúncio. Deduplicação (1/dia por visitante) e
  // exclusão do próprio dono acontecem no backend (register_ad_view); uma falha aqui nunca
  // deve impedir a página de renderizar normalmente.
  // Só na visão do ANÚNCIO: a página da empresa (?view=empresa) usa o mesmo
  // id e contava como visualização do anúncio de origem (seção 217).
  const viewRegisteredRef = useRef(null);
  useEffect(() => {
    if (view !== "anuncio") return;
    if (!supplier?.id || viewRegisteredRef.current === supplier.id) return;
    viewRegisteredRef.current = supplier.id;
    const sessionId = getOrCreateVisitorSessionId();
    api.metrics.registerView(supplier.id, sessionId).catch((error) => {
      console.warn("Não foi possível registrar a visualização do anúncio:", error);
    });
  }, [supplier?.id, view]);

  if (!supplier) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="animate-pulse text-sm text-slate-400 dark:text-slate-500">Carregando…</div>
      </div>
    );
  }

  const isCompanyView = view === "empresa";
  const coverImage = isCompanyView ? companyProfile?.cover_url : supplier.cover_url;
  const planBadge = PLAN_BADGE[plan] || null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Rótulo genérico "Voltar" de propósito: o destino agora depende do
          histórico real, então prometer um destino específico voltaria a
          mentir para quem chegou por outro caminho. */}
      {/* O ANÚNCIO ganhou banner de identidade (seção 142); a visão de
          EMPRESA continua com a capa, porque lá o cabeçalho é outro assunto
          e a foto de capa da empresa é escolhida para esse lugar. */}
      {isCompanyView ? (
        <Cover
          image={coverImage}
          tone="empresa"
          onBack={goBack}
          backLabel="Voltar"
        />
      ) : (
        <>
          <AdCompanyBanner
            supplier={supplier}
            categoria={categoryLabels[supplier.category] || supplier.category}
            verified={isVerified}
            planBadge={planBadge}
            onBack={goBack}
          />
          <AdBreadcrumb
            categoria={categoryLabels[supplier.category] || supplier.category}
            categoriaUrl={`${createPageUrl("Suppliers")}?category=${supplier.category || ""}`}
            nome={supplier.business_name}
          />
        </>
      )}

      {/* -mt-14 só na visão de empresa: era o que fazia o conteúdo subir por
          cima da capa. O banner do anúncio não é para ser encoberto. */}
      {/* max-w-site na visão de ANÚNCIO: com max-w-site (1280px) sobrava
          faixa vazia dos dois lados em telas grandes, e as três colunas
          ficavam apertadas -- a galeria em especial, que é o conteúdo novo.
          A visão de EMPRESA continua em 7xl, porque lá é uma coluna de
          leitura e linha muito longa cansa. */}
      <div className={`relative z-10 mx-auto px-6 pb-16 ${isCompanyView ? "max-w-site -mt-14" : "max-w-site mt-6"}`}>
        {companyGated ? (
          /* Perfil da empresa atrás do cadastro (seção 84). O muro nomeia o
             que há do outro lado em vez de só dizer "faça login" -- e o
             anúncio que trouxe o visitante continua a um clique. */
          <Panel bodyClassName="px-6 py-14 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-orange-50 dark:bg-orange-500/10">
              <Lock className="h-6 w-6 text-orange-500" />
            </div>
            <h1 className="font-display text-2xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-3xl">
              Perfil da empresa é para quem tem conta
            </h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Crie sua conta gratuita para ver todos os anúncios desta empresa, o catálogo
              completo de produtos e as avaliações somadas de todos os anúncios dela.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link to={createPageUrl("Register")}>
                <Button className="h-11 rounded-card bg-orange-500 px-7 font-bold text-white hover:bg-orange-600">
                  Criar conta gratuita
                </Button>
              </Link>
              <Link to={createPageUrl("Login")}>
                <Button variant="outline" className="h-11 rounded-card px-7 font-bold">
                  Já tenho conta
                </Button>
              </Link>
            </div>
            <button
              type="button"
              onClick={goBack}
              className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-orange-600 dark:text-slate-400 dark:hover:text-orange-400"
            >
              <ArrowLeft className="h-4 w-4" />
              Voltar
            </button>
          </Panel>
        ) : isCompanyView ? (
          <CompanyProfileView
            companyProfile={companyProfile}
            isLoadingCompanyProfile={isLoadingCompanyProfile}
            companyName={companyName}
            companyPhone={companyPhone}
            companySegmentLabel={companySegmentLabel}
            companySuppliers={companySuppliers}
            companyProducts={companyProducts}
            companyReviews={companyReviews}
            companyReviewsCount={companyReviewsCount}
            companyReviewsAvg={companyReviewsAvg}
            isVerified={isVerified}
            supplier={supplier}
            adUrl={adUrl}
            hasFullAccess={hasFullAccess}
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-12">
            {/* TRÊS COLUNAS, no arranjo do template (seção 142): galeria |
                detalhes | contato. Em 12 colunas e não em 3 porque as
                larguras não são iguais -- a galeria precisa de mais que um
                terço para a imagem grande caber ao lado das miniaturas, e o
                contato precisa de menos. Abaixo de lg tudo empilha.

                ---------- Coluna 1: galeria ---------- */}
            <div className="space-y-6 lg:col-span-5">
              {/* ---------- Galeria (seção 142) ----------
                  Primeiro bloco da coluna principal, no formato do template:
                  miniaturas verticais + imagem grande. Saiu do cabeçalho, onde
                  sobravam ~150px espremidos entre a navbar e o painel de
                  identidade.

                  O estado vazio aparece SÓ PARA O DONO: para o visitante, um
                  anúncio sem foto simplesmente não mostra galeria, em vez de
                  anunciar a falta. Para o dono é uma chamada para ação, com o
                  link do editor. */}
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <Panel bodyClassName="p-4 md:p-5">
                  {gallery.length > 0 ? (
                    <AdGallery images={gallery} alt={supplier.business_name} />
                  ) : (
                    /* Sem foto, o painel aparece para TODOS (seção 145) -- antes
                       só o dono via, e para o visitante a coluna ficava vazia.
                       O texto é que muda conforme quem está olhando. */
                    <AdGalleryEmpty
                      isOwner={isOwner}
                      editUrl={`${createPageUrl("AdEditor")}?id=${supplier.id}`}
                    />
                  )}
                </Panel>
              </motion.div>

              {/* PRODUTOS logo abaixo das imagens (a pedido). Estavam na
                  coluna do meio, que já era a mais cheia, enquanto embaixo da
                  galeria sobrava coluna vazia. Produto é conteúdo visual --
                  fica perto das fotos, não perto do telefone. */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
              >
                <SupplierProductsSection supplierId={supplier.id} />
              </motion.div>

            </div>

            {/* ---------- Coluna 2: identidade, informações e avaliações ---------- */}
            <div className="space-y-6 lg:col-span-4">
              {/* ---------- Detalhes do anúncio (seção 142) ----------
                  REESCRITO no formato do template. O painel antigo repetia
                  TUDO o que agora está no banner: logo, nome, selo de
                  verificado, selo de plano, local e nota. Numa coluna de
                  ~395px o nome ainda quebrava em quatro linhas.

                  Aqui sobra o que o banner NÃO diz: categoria, os atributos
                  comerciais e os destaques. */}
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
                <Panel bodyClassName="p-6">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700 dark:bg-orange-500/10 dark:text-orange-400">
                    <Package className="h-3.5 w-3.5" />
                    {categoryLabels[supplier.category] || supplier.category}
                  </span>

                  {/* ATRIBUTOS -- a linha de ícones do template. Lá são
                      Condição/Ano/Horímetro, que são campos de máquina
                      agrícola e não existem aqui (nem fariam sentido para
                      "Embalagens" ou "Serviços Digitais"). Trocados por
                      quatro campos REAIS que servem a qualquer categoria, e
                      cada um só aparece se estiver preenchido. */}
                  {(supplier.location || supplier.min_order || supplier.delivery_info || supplier.created_at) && (
                    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-y border-slate-100 py-4 dark:border-slate-800">
                      {supplier.location && (
                        <Atributo icon={MapPin} label="Localização">{supplier.location}</Atributo>
                      )}
                      {supplier.min_order && (
                        <Atributo icon={Package} label="Pedido mínimo">{supplier.min_order}</Atributo>
                      )}
                      {supplier.delivery_info && (
                        <Atributo icon={Truck} label="Entrega">{supplier.delivery_info}</Atributo>
                      )}
                      {supplier.created_at && (
                        <Atributo icon={CalendarDays} label="No NEXAR desde">
                          {new Date(supplier.created_at).getFullYear()}
                        </Atributo>
                      )}
                    </div>
                  )}

                  {supplier.description && (
                    <p className="mt-5 leading-relaxed text-slate-600 dark:text-slate-300">
                      {supplier.description}
                    </p>
                  )}

                  {/* DESTAQUES -- é o checklist do template, alimentado pelas
                      `tags` do anúncio. O campo já existia no banco e nunca
                      tinha sido exibido em lugar nenhum. */}
                  {supplier.tags?.length > 0 && (
                    <div className="mt-5">
                      <p className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Destaques:</p>
                      <ul className="space-y-1.5">
                        {supplier.tags.map((tag) => (
                          <li key={tag} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                            {tag}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Link
                    to={companyUrl}
                    className="mt-5 inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 transition-colors hover:text-orange-700 dark:text-orange-400"
                  >
                    <Building2 className="h-4 w-4" />
                    Ver perfil da empresa
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Panel>
              </motion.div>

              {/* ---------- Informações ---------- */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.06 }}
              >
                {/* SÓ CONTATO desde a seção 142. "Pedido mínimo" e "Entrega"
                    subiram para a linha de atributos no painel de detalhes, e
                    ficar nos dois lugares era repetir o mesmo dado na mesma
                    coluna, a dois blocos de distância. A divisão agora é
                    clara: atributos = condição comercial, este painel = como
                    falar com o fornecedor. */}
                <Panel title="Contato" icon={Phone} bodyClassName="px-5 py-1">
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {hasFullAccess && supplier.phone && (
                      <InfoRow icon={Phone} label="Telefone">
                        {supplier.phone}
                      </InfoRow>
                    )}
                    {hasFullAccess && supplier.email && (
                      <InfoRow icon={Mail} label="Email">
                        <a href={`mailto:${supplier.email}`} className="hover:text-orange-600 dark:hover:text-orange-400">
                          {supplier.email}
                        </a>
                      </InfoRow>
                    )}
                    {hasFullAccess && supplier.website && (
                      <InfoRow icon={Globe} label="Site">
                        <a
                          href={supplier.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-orange-600 hover:underline dark:text-orange-400"
                        >
                          {supplier.website}
                        </a>
                      </InfoRow>
                    )}

                    {/* Porta de login. Antes era um aviso em âmbar; agora usa
                        o laranja do sistema e um cadeado, que comunica melhor
                        que é conteúdo bloqueado, não um alerta de erro. */}
                    {!hasFullAccess && (
                      <div className="py-4">
                        <div className="flex items-start gap-3 rounded-card border border-orange-200 bg-orange-50 p-4 dark:border-orange-500/30 dark:bg-orange-500/10">
                          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
                          <p className="text-sm leading-relaxed text-orange-900 dark:text-orange-200">
                            <Link
                              to={createPageUrl("Register")}
                              className="font-bold underline underline-offset-2"
                            >
                              Crie uma conta gratuita ou faça login
                            </Link>{" "}
                            para ver telefone, email, site e informações de entrega deste
                            fornecedor.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </Panel>
              </motion.div>

              {/* Produtos — catálogo agora é benefício de plano por CONTAGEM
                  (limite de produtos/imagens, ver plans.js), não mais uma
                  seção escondida por completo pra quem não é profissional/
                  premium -- todo plano (inclusive básico) pode ter produtos
                  no catálogo, então a seção aparece pra qualquer anúncio que
                  tenha pelo menos 1 produto vinculado (SupplierProductsSection
                  já retorna null quando a lista vem vazia). */}
              {/* ---------- Avaliações (seção 148) ----------
                  VOLTARAM PARA A COLUNA DO MEIO. Na 145 foram para a da
                  galeria porque aquela terminava cedo; com produtos e fotos
                  preenchidos o problema inverteu -- a esquerda ia a y=2373 e
                  o meio parava em y=1198. Aqui as duas crescem juntas.

                  E a LISTA vem antes do FORMULÁRIO: quem chega quer LER o que
                  disseram; escrever é o segundo movimento, e de poucos. */}
              {/* ---------- Avaliações ----------
                  O FORMULÁRIO VEM ANTES DA LISTA (a pedido). Ele estava
                  depois, então em anúncio com muitas avaliações a pessoa
                  tinha de rolar a lista inteira para descobrir que podia
                  avaliar -- a ação ficava escondida atrás do conteúdo que ela
                  gera. */}
              {/* ---------- Avaliações já recebidas ---------- */}
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.18 }}
                className="space-y-6"
              >
                <Panel
                  title="Avaliações"
                  icon={MessageSquare}
                  count={reviews.length}
                  action={
                    supplier.rating > 0 && (
                      <div className="flex items-center gap-2">
                        <Stars value={supplier.rating} className="h-3.5 w-3.5" />
                        <span className="tnum font-display text-lg font-black text-slate-900 dark:text-slate-50">
                          {supplier.rating?.toFixed(1)}
                        </span>
                      </div>
                    )
                  }
                >
                  {/* A query de avaliações não tinha tratamento de erro: uma
                      recusa do banco caía no mesmo "Nenhuma avaliação ainda"
                      de um anúncio sem avaliação, e o problema ficava
                      invisível. Mesmo defeito corrigido na listagem (seção
                      96) e no formulário (seção 97). */}
                  {isErrorReviews ? (
                    <div
                      role="alert"
                      className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        Não foi possível carregar as avaliações.
                        {reviewsError?.message ? ` (${reviewsError.message})` : ""}
                      </span>
                    </div>
                  ) : (
                    <ReviewList
                      reviews={reviews}
                      emptyMessage="Nenhuma avaliação ainda. Seja o primeiro!"
                    />
                  )}
                </Panel>

              </motion.div>

              <ReviewForm supplierId={supplier.id} supplierName={supplier.business_name} />

            </div>

            {/* ---------- Coluna 3: contato ---------- */}
            <div className="lg:col-span-3">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="sticky top-6"
              >
                <ContactPanel
                  supplier={supplier}
                  displayName={supplier.business_name}
                  hasFullAccess={hasFullAccess}
                />
              </motion.div>
            </div>
          </div>
        )}
      </div>

      <Footer />
    </div>
  );
}

// Perfil público da EMPRESA (dono do anúncio) — reúne dados comerciais de
// user_profiles (via RPC segura), os anúncios ativos da empresa e a
// reputação agregada. Nunca exibe full_name, email de login, dados de
// assinatura ou o created_by/uuid da conta.
function CompanyProfileView({
  companyProfile,
  isLoadingCompanyProfile,
  companyName,
  companyPhone,
  companySegmentLabel,
  companySuppliers,
  companyProducts,
  companyReviews,
  companyReviewsCount,
  companyReviewsAvg,
  isVerified,
  supplier,
  adUrl,
  hasFullAccess,
}) {
  const initials = companyName?.[0]?.toUpperCase() || "?";

  if (isLoadingCompanyProfile) {
    return (
      <div className="animate-pulse py-24 text-center text-sm text-slate-400 dark:text-slate-500">
        Carregando perfil da empresa…
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        {/* ---------- Identidade da empresa ---------- */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}>
          <Panel bodyClassName="p-6 md:p-7">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-card border border-slate-200 bg-orange-50 dark:border-slate-800 dark:bg-orange-500/10">
                {companyProfile?.avatar_url ? (
                  <img src={companyProfile.avatar_url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <span className="font-display text-3xl font-black text-orange-400 dark:text-orange-500/70">
                      {initials}
                    </span>
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                {isVerified && (
                  <span className="mb-2 inline-flex items-center gap-1 rounded-full bg-orange-500 px-2.5 py-1 text-[11px] font-semibold text-white">
                    <BadgeCheck className="h-3.5 w-3.5" />
                    Verificado
                  </span>
                )}
                <h1 className="font-display text-3xl font-black leading-tight tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">
                  {companyName}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-500 dark:text-slate-400">
                  {companySegmentLabel && (
                    <span className="rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 dark:bg-orange-500/10 dark:text-orange-400">
                      {companySegmentLabel}
                    </span>
                  )}
                  {(companyProfile?.city || companyProfile?.state) && (
                    <span className="flex items-center gap-1.5">
                      <MapPin className="h-4 w-4 text-orange-500" />
                      {[companyProfile?.city, companyProfile?.state].filter(Boolean).join(" - ")}
                    </span>
                  )}
                  {companyReviewsCount > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Star className="h-4 w-4 fill-orange-500 text-orange-500" />
                      <span className="tnum font-bold text-slate-900 dark:text-slate-100">
                        {companyReviewsAvg.toFixed(1)}
                      </span>
                      <span className="tnum">({companyReviewsCount})</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {(companyPhone || (hasFullAccess && supplier?.website)) && (
              <div className="mt-6 divide-y divide-slate-100 border-t border-slate-100 dark:divide-slate-800 dark:border-slate-800">
                {companyPhone && (
                  <InfoRow icon={Phone} label="Telefone da empresa">
                    {companyPhone}
                  </InfoRow>
                )}
                {hasFullAccess && supplier?.website && (
                  <InfoRow icon={Globe} label="Site">
                    <a
                      href={supplier.website}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-orange-600 hover:underline dark:text-orange-400"
                    >
                      {supplier.website}
                    </a>
                  </InfoRow>
                )}
              </div>
            )}

            {companyProfile?.company_description_available && companyProfile?.company_description && (
              <p className="mt-6 leading-relaxed text-slate-600 dark:text-slate-300">
                {companyProfile.company_description}
              </p>
            )}
          </Panel>
        </motion.div>

        {/* ---------- Anúncios desta empresa ---------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
        >
          <Panel title="Anúncios desta empresa" icon={Building2} count={companySuppliers.length}>
            <div className="grid gap-3 sm:grid-cols-2">
              {companySuppliers.map((ad) => (
                <Link
                  key={ad.id}
                  to={`${createPageUrl("SupplierProfile")}?id=${ad.id}`}
                  className="group flex items-center gap-3 rounded-card border border-slate-200 p-3 transition-colors hover:border-orange-300 hover:bg-orange-50 dark:border-slate-800 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-card bg-slate-100 dark:bg-slate-800">
                    {ad.logo_url ? (
                      <img src={ad.logo_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="font-display text-base font-black text-slate-400 dark:text-slate-500">
                        {ad.business_name?.[0]?.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-800 group-hover:text-orange-700 dark:text-slate-100 dark:group-hover:text-orange-400">
                      {ad.business_name}
                    </p>
                    <p className="truncate text-xs text-slate-400 dark:text-slate-500">{ad.location}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-orange-500 dark:text-slate-600" />
                </Link>
              ))}
            </div>
          </Panel>
        </motion.div>

        {/* ---------- Catálogo completo da empresa ---------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
        >
          <CompanyProductsSection products={companyProducts} />
        </motion.div>

        {/* ---------- Avaliações da empresa ---------- */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
        >
          <Panel
            title="Avaliações Recebidas"
            icon={Star}
            count={companyReviewsCount}
            action={
              companyReviewsCount > 0 && (
                <div className="flex items-center gap-2">
                  <Stars value={companyReviewsAvg} className="h-3.5 w-3.5" />
                  <span className="tnum font-display text-lg font-black text-slate-900 dark:text-slate-50">
                    {companyReviewsAvg.toFixed(1)}
                  </span>
                </div>
              )
            }
          >
            <ReviewList reviews={companyReviews} />
          </Panel>
        </motion.div>
      </div>

      {/* ---------- Contato (vinculado ao anúncio de origem) ---------- */}
      <div className="lg:col-span-1">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="sticky top-6"
        >
          <ContactPanel
            supplier={supplier}
            displayName={companyName}
            hasFullAccess={hasFullAccess}
            footer={
              /* "Ver o anúncio", não "Voltar ao anúncio": daqui isso é uma
                 IDA (quem chegou pela aba Empresas nunca esteve no anúncio).
                 O voltar de verdade é o da capa, que segue o histórico. */
              <Link
                to={adUrl}
                className="block pt-1 text-center text-xs text-slate-400 transition-colors hover:text-orange-600 dark:text-slate-500 dark:hover:text-orange-400"
              >
                Ver o anúncio desta empresa →
              </Link>
            }
          />
        </motion.div>
      </div>
    </div>
  );
}
