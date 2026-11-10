import React, { useState, useMemo, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Search, X, MapPin, Package, Building2, SearchX, AlertTriangle, Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createPageUrl } from "@/utils";
import { CATEGORIES } from "@/lib/categories";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SupplierCard from "../components/shared/SupplierCard";
import CompanyCard from "../components/suppliers/CompanyCard";
import Footer from "../components/shared/Footer";
import AdvancedFilters from "../components/suppliers/AdvancedFilters";

const DEFAULT_ADVANCED = { state: "", minRating: 0, priceRange: null };

/** Atraso entre a última tecla e a ida ao banco. Sem isto, cada caractere
 *  digitado na busca disparava DUAS RPCs (lista + contagem) -- e, como a
 *  listagem é filtrada no banco desde a seção 84, não havia nada em cache
 *  para segurar a tela no intervalo. */
const SEARCH_DEBOUNCE_MS = 300;

function useDebounced(value, delay = SEARCH_DEBOUNCE_MS) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** "R$ 1.500,00" -> 1500. O parse anterior trocava a vírgula por ponto e
 *  deixava os separadores de milhar: "1.500,00" virava "1.500.00", que o
 *  parseFloat lê como 1.5 -- mil vezes menor. Um fornecedor com pedido mínimo
 *  de R$ 1.000 caía na faixa "Até R$ 50". Ver seção 96. */
function parseMinOrder(raw) {
  if (!raw) return NaN;
  const digits = String(raw).replace(/[^\d.,]/g, "");
  if (!digits) return NaN;
  // Separador decimal é o ÚLTIMO . ou , que aparecer; todo o resto é milhar.
  const lastComma = digits.lastIndexOf(",");
  const lastDot = digits.lastIndexOf(".");
  const decimalAt = Math.max(lastComma, lastDot);
  // Só é decimal de verdade se sobrarem 1 ou 2 casas depois dele ("1.500" é
  // mil e quinhentos, não um e meio).
  const decimals = decimalAt === -1 ? 0 : digits.length - decimalAt - 1;
  if (decimalAt === -1 || decimals === 0 || decimals > 2) {
    return parseFloat(digits.replace(/[.,]/g, ""));
  }
  const intPart = digits.slice(0, decimalAt).replace(/[.,]/g, "");
  return parseFloat(`${intPart}.${digits.slice(decimalAt + 1)}`);
}

/** Estado vazio/erro. Aquecido junto com o resto (seção 72): a versão
 *  anterior abria com uma régua preta de 2px e um carimbo preto -- correto
 *  para catálogo técnico, duro demais para o público daqui. */
function EmptyState({ icon: Icon, title, description, tone = "neutral" }) {
  const isError = tone === "error";
  return (
    <div className="rounded-card border border-slate-200 bg-white px-6 py-16 text-center dark:border-slate-800 dark:bg-slate-900">
      <div
        className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
          isError
            ? "bg-destructive/10 text-destructive"
            : "bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400"
        }`}
      >
        <Icon className="h-6 w-6" strokeWidth={2} />
      </div>
      <h3 className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  );
}

// A área de imagem do esqueleto acompanha o cartão real (seção 178): 2:1 no
// anúncio (SupplierCard), faixa de 80px na empresa (CompanyCard). Era h-44
// para os dois -- não batia com nenhum, e a tela "pulava" ao carregar.
function CardSkeleton({ empresa = false }) {
  return (
    <div className="listing-card overflow-hidden">
      <div className={`${empresa ? "h-20" : "aspect-[2/1]"} animate-pulse bg-slate-100 dark:bg-slate-800`} />
      <div className="space-y-2.5 p-4">
        <div className="h-5 w-1/2 animate-pulse rounded-full bg-slate-100 dark:bg-slate-800" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-3 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
      </div>
    </div>
  );
}

/** Bloco de conversão no fim da amostra. Aparece só para quem não tem conta
 *  e só quando de fato há mais do que o exibido -- nunca como um banner
 *  genérico pedindo cadastro sem motivo.
 *
 *  `hiddenCount` é opcional: na aba Anúncios sabemos o total exato
 *  (suppliers_public_count), mas na aba Empresas não existe RPC de contagem,
 *  então o muro aparece sem número em vez de inventar um. */
function SignupWall({ hiddenCount = null, sampleSize = 0 }) {
  return (
    <div className="mt-6 overflow-hidden rounded-card bg-slate-950 px-6 py-10 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-orange-500/15">
        <Lock className="h-5 w-5 text-orange-500" />
      </div>
      <h3 className="font-display text-2xl font-black tracking-tight text-white">
        {hiddenCount !== null ? (
          <>
            Mais <span className="tnum text-orange-500">{hiddenCount}</span>{" "}
            {hiddenCount === 1 ? "fornecedor esperando" : "fornecedores esperando"}
          </>
        ) : (
          <>
            Você está vendo{" "}
            <span className="tnum text-orange-500">{sampleSize}</span> resultados
          </>
        )}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-400">
        Crie sua conta gratuita para ver todos os resultados da busca, acessar o perfil
        completo das empresas e falar direto com os fornecedores.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link to={createPageUrl("Register")}>
          <Button className="h-11 rounded-card bg-orange-500 px-7 font-bold text-white hover:bg-orange-600">
            Criar conta gratuita
          </Button>
        </Link>
        <Link to={createPageUrl("Login")}>
          <Button
            variant="outline"
            className="h-11 rounded-card border-white/25 px-7 font-bold text-white hover:bg-white/10"
          >
            Já tenho conta
          </Button>
        </Link>
      </div>
    </div>
  );
}

export default function Suppliers() {
  const { isAuthenticated } = useAuth();
  // useSearchParams em vez de new URLSearchParams(window.location.search): o
  // segundo não reage a navegação client-side que só muda a query na mesma
  // rota (ex.: vir da CategoryGrid da Home com ?category=), e a página ficava
  // presa no filtro antigo até um refresh duro. Convenção documentada no
  // CLAUDE.md -- a página estava com o padrão antigo e foi migrada aqui.
  const [searchParams, setSearchParams] = useSearchParams();

  const [tab, setTab] = useState(() =>
    searchParams.get("tab") === "empresas" ? "empresas" : "anuncios"
  );
  const [searchQuery, setSearchQuery] = useState(() => searchParams.get("search") || "");
  const [selectedCategory, setSelectedCategory] = useState(() => searchParams.get("category") || "all");
  const [cityQuery, setCityQuery] = useState(() => searchParams.get("city") || "");
  const [advanced, setAdvanced] = useState(DEFAULT_ADVANCED);

  // Re-sincroniza quando a URL muda sem remontar a página.
  useEffect(() => {
    setTab(searchParams.get("tab") === "empresas" ? "empresas" : "anuncios");
    setSearchQuery(searchParams.get("search") || "");
    setSelectedCategory(searchParams.get("category") || "all");
    setCityQuery(searchParams.get("city") || "");
  }, [searchParams]);

  // A aba era só estado local: trocar para "Empresas" não mexia na URL, então
  // o ?tab=empresas era LIDO mas nunca ESCRITO -- atualizar a página ou mandar
  // o link para alguém voltava para Anúncios. Agora a URL manda.
  const changeTab = (id) => {
    setTab(id);
    const next = new URLSearchParams(searchParams);
    if (id === "empresas") next.set("tab", "empresas");
    else next.delete("tab");
    setSearchParams(next, { replace: true });
  };

  // Só o valor "assentado" vai ao banco; o campo continua respondendo a cada
  // tecla porque quem controla o <Input> é o estado imediato.
  const debouncedSearch = useDebounced(searchQuery);
  const debouncedCity = useDebounced(cityQuery);

  // A listagem passou a vir de suppliers_public_list (ver
  // supabase/anon-content-gate.sql): nome/categoria/cidade são filtrados NO
  // BANCO e o corte da amostra acontece depois disso -- por isso a queryKey
  // inclui os filtros. Antes era um select direto de 200 linhas filtrado em
  // JS, o que hoje nem funcionaria sem conta (anon perdeu o select na tabela).
  //
  // NÃO usar `initialData: []` aqui: no React Query v5 isso deixa a query em
  // status "success" desde o primeiro render, então `isLoading` nunca fica
  // true -- o esqueleto virava código morto e, no lugar dele, a tela piscava
  // "Nenhum anúncio encontrado" antes da primeira resposta e a cada troca de
  // filtro. `placeholderData: keepPreviousData` é o que resolve de verdade:
  // segura a lista anterior enquanto a nova carrega, em vez de esvaziar.
  const {
    data: suppliers = [],
    isLoading,
    isError: isErrorSuppliers,
  } = useQuery({
    queryKey: ["suppliers", debouncedSearch, selectedCategory, debouncedCity],
    queryFn: () =>
      api.catalog.listSuppliers({
        search: debouncedSearch,
        category: selectedCategory === "all" ? "" : selectedCategory,
        city: debouncedCity,
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "anuncios",
  });

  // Total real (sem o corte). É o que permite dizer "mostrando 8 de 47" em
  // vez de simplesmente esconder o acervo do visitante.
  const { data: totalSuppliers = 0 } = useQuery({
    queryKey: ["suppliers-count", debouncedSearch, selectedCategory, debouncedCity],
    queryFn: () =>
      api.catalog.countSuppliers({
        search: debouncedSearch,
        category: selectedCategory === "all" ? "" : selectedCategory,
        city: debouncedCity,
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "anuncios",
  });

  // Teto da amostra do visitante, vindo do banco. Serve para saber se a aba
  // Empresas (que não tem RPC de contagem) foi ou não truncada.
  const { data: previewLimit = null } = useQuery({
    queryKey: ["anon-preview-limit"],
    queryFn: () => api.catalog.previewLimit(),
    enabled: !isAuthenticated,
    staleTime: Infinity,
  });

  // Selo "Verificado": buscado uma vez para toda a lista via RPC segura (representa a
  // assinatura do DONO de cada anúncio, nunca supplier.verified isolado ou o plano de
  // quem está navegando). Ver suppliers_verified_status em supabase/rls-policies.sql.
  const supplierIds = useMemo(() => suppliers.map((s) => s.id), [suppliers]);
  const { data: verifiedMap = {} } = useQuery({
    queryKey: ["suppliers-verified", supplierIds],
    queryFn: () => api.verification.getForSuppliers(supplierIds),
    enabled: tab === "anuncios" && supplierIds.length > 0,
  });

  // Aba "Empresas": uma linha por empresa (agregando os anúncios ativos dela),
  // resolvida no banco via RPC security definer -- ver company_search_public
  // em supabase/company-search-rpc.sql. Nunca filtrada/agrupada no client
  // (dados de user_profiles não estão disponíveis fora da RPC).
  const {
    data: companies = [],
    isLoading: isLoadingCompanies,
    isError: isErrorCompanies,
  } = useQuery({
    queryKey: ["companies-search", debouncedSearch, selectedCategory, debouncedCity],
    queryFn: () =>
      api.company.search({
        search: debouncedSearch,
        category: selectedCategory === "all" ? "" : selectedCategory,
        city: debouncedCity,
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "empresas",
    retry: false,
  });

  const companyIds = useMemo(
    () => companies.map((c) => c.representative_supplier_id),
    [companies]
  );
  const { data: companyVerifiedMap = {} } = useQuery({
    queryKey: ["companies-verified", companyIds],
    queryFn: () => api.verification.getForSuppliers(companyIds),
    enabled: tab === "empresas" && companyIds.length > 0,
  });

  // Count active advanced filters
  const advancedActiveCount = [
    advanced.state !== "",
    advanced.minRating > 0,
    advanced.priceRange !== null,
  ].filter(Boolean).length;

  // Busca/categoria/cidade NÃO são refiltradas aqui: desde a seção 84 quem
  // filtra é o banco (suppliers_public_list), e manter uma segunda cópia da
  // regra em JS foi exatamente o que produziu a regressão das tags na seção
  // 93 -- duas implementações da mesma busca que divergem em silêncio. Aqui
  // sobra só o que o banco não tem como fazer: os filtros avançados, que
  // dependem de `min_order` (texto livre) e de UF extraída da localização.
  const filteredSuppliers = useMemo(() => {
    if (advancedActiveCount === 0) return suppliers;
    return suppliers.filter((s) => {
      const matchState = !advanced.state || s.location?.toUpperCase().includes(advanced.state);
      const matchRating = advanced.minRating === 0 || (s.rating && s.rating >= advanced.minRating);
      const matchPrice =
        !advanced.priceRange ||
        (() => {
          const val = parseMinOrder(s.min_order);
          // Pedido mínimo não informado não é motivo para sumir do resultado.
          if (isNaN(val)) return true;
          return val >= advanced.priceRange.min && val <= advanced.priceRange.max;
        })();

      return matchState && matchRating && matchPrice;
    });
  }, [suppliers, advanced, advancedActiveCount]);

  const hasAnyFilter = selectedCategory !== "all" || searchQuery || cityQuery || advancedActiveCount > 0;

  const clearAll = () => {
    setSelectedCategory("all");
    setSearchQuery("");
    setCityQuery("");
    setAdvanced(DEFAULT_ADVANCED);
    // Limpar o estado sem limpar a URL deixava ?category=... pendurado: bastava
    // qualquer coisa remontar o efeito de sincronia para o filtro "limpo"
    // voltar sozinho.
    const next = new URLSearchParams();
    if (tab === "empresas") next.set("tab", "empresas");
    setSearchParams(next, { replace: true });
  };

  const resultCount = tab === "anuncios" ? filteredSuppliers.length : companies.length;
  const busy = tab === "anuncios" ? isLoading : isLoadingCompanies;

  // Muro de cadastro. O banco já corta a amostra (anon_preview_limit) --
  // isto aqui só CONTA a história: quantos anúncios existem além dos que
  // estão na tela. Se o corte fosse feito aqui, seria contornável.
  //
  // A diferença é contra `suppliers.length` (o que o BANCO devolveu), não
  // contra `filteredSuppliers.length`: os filtros avançados rodam só no
  // client e não entram no suppliers_public_count, então usar a lista já
  // filtrada inflava o número -- o muro prometia "mais 17 fornecedores" sem
  // saber se algum deles passaria no filtro de UF/nota que o visitante
  // acabara de aplicar.
  const hiddenCount = Math.max(0, totalSuppliers - suppliers.length);
  const showSignupWall = !isAuthenticated && tab === "anuncios" && !busy && hiddenCount > 0;

  // A aba Empresas também é cortada no banco (company_search_preview), mas não
  // existe RPC de contagem para ela -- então a tela dizia "8 empresas
  // encontradas" para um acervo de qualquer tamanho, apresentando uma amostra
  // como se fosse o resultado completo. Sem o total, o sinal honesto possível
  // é: veio exatamente o teto, então provavelmente há mais.
  const companiesTruncated =
    !isAuthenticated &&
    tab === "empresas" &&
    previewLimit !== null &&
    companies.length >= previewLimit;

  const tabs = [
    { id: "anuncios", label: "Anúncios", icon: Package },
    { id: "empresas", label: "Empresas", icon: Building2 },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* ================= CABEÇALHO EDITORIAL =================
          Eyebrow em mono, título em peso 900 com salto de escala grande, e
          uma régua laranja grossa fechando o bloco. É o oposto do padrão
          "título + subtítulo cinza centralizado". */}
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-site px-6 pt-10">
          <div className="label-mono mb-3 flex items-center gap-2 text-orange-600 dark:text-orange-400">
            <span className="h-1.5 w-1.5 bg-orange-500" />
            Catálogo NEXAR
          </div>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <h1 className="font-display text-5xl font-black leading-[0.95] tracking-tighter text-slate-900 dark:text-slate-50 md:text-7xl">
              Fornecedores
            </h1>
            <p className="max-w-xs text-sm leading-snug text-slate-500 dark:text-slate-400 sm:text-right">
              Rede de fornecedores verificados para quem compra em pequena e média escala.
            </p>
          </div>

          {/* Abas sublinhadas -- não pílula dentro de caixa cinza. O estado
              ativo passou de quase-preto para laranja: mesma clareza, sem a
              dureza que deixava o topo da página com ar institucional. */}
          <nav role="tablist" aria-label="Tipo de resultado" className="-mb-px mt-8 flex gap-8">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => changeTab(id)}
                className={`group flex items-center gap-2 border-b-2 py-3.5 font-display text-sm font-bold transition-colors ${
                  tab === id
                    ? "border-orange-500 text-orange-600 dark:text-orange-400"
                    : "border-transparent text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={2.5} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* ================= BARRA DE BUSCA =================
          Uma barra única dividida por fios de cabelo, em vez de três campos
          arredondados soltos flutuando lado a lado. */}
      <div className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-site px-6 py-4">
          <div className="flex flex-col divide-y divide-slate-200 border border-slate-200 dark:divide-slate-800 dark:border-slate-800 md:flex-row md:divide-x md:divide-y-0">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <Input
                placeholder="Nome da empresa ou produto..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-12 rounded-none border-0 bg-transparent pl-11 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="Limpar busca"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="relative w-full md:w-60">
              <MapPin className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <Input
                placeholder="Cidade ou estado..."
                value={cityQuery}
                onChange={(e) => setCityQuery(e.target.value)}
                className="h-12 rounded-none border-0 bg-transparent pl-11 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-orange-500"
              />
              {cityQuery && (
                <button
                  onClick={() => setCityQuery("")}
                  aria-label="Limpar cidade"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger className="h-12 w-full rounded-none border-0 bg-transparent text-sm shadow-none focus:ring-1 focus:ring-inset focus:ring-orange-500 md:w-56">
                <SelectValue placeholder="Categoria" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as Categorias</SelectItem>
                {CATEGORIES.map(({ key, label }) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Filtros avançados -- só se aplicam a anúncios: faixa de preço/
              avaliação/estado não têm equivalente direto na busca agregada por
              empresa (RPC company_search_public). */}
          {tab === "anuncios" && (
            <div className="relative mt-3">
              <AdvancedFilters
                filters={advanced}
                onChange={setAdvanced}
                onClear={() => setAdvanced(DEFAULT_ADVANCED)}
                activeCount={advancedActiveCount}
              />
            </div>
          )}
        </div>
      </div>

      {/* ================= RESULTADOS ================= */}
      {/* <div>, não <main>: o Layout.jsx já envolve toda página num <main>, e
          só pode haver UM landmark main por documento -- com dois, o leitor de
          tela anuncia dois "conteúdos principais". Achado com o navegador na
          seção 107. */}
      <div className="mx-auto max-w-site px-6 py-8">
        <div className="mb-4 flex items-end justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
          <div className="text-sm text-slate-500 dark:text-slate-400">
            {busy ? (
              "Carregando…"
            ) : (
              <>
                <span className="tnum font-display text-2xl font-black leading-none text-orange-600 dark:text-orange-400">
                  {resultCount}
                </span>
                <span className="ml-2">
                  {tab === "anuncios"
                    ? `anúncio${resultCount !== 1 ? "s" : ""}`
                    : `empresa${resultCount !== 1 ? "s" : ""}`}
                  {/* Sem conta, deixa explícito que o número exibido é uma
                      amostra -- esconder o total faria o visitante achar que
                      o acervo é pequeno, que é o oposto do objetivo.
                      Com filtro avançado ativo o total do banco não vale como
                      denominador (ele não conhece esses filtros), então a
                      tela volta a dizer só quantos achou. */}
                  {showSignupWall && advancedActiveCount === 0
                    ? ` de ${totalSuppliers}`
                    : companiesTruncated
                      ? " nesta amostra"
                      : " encontrados"}
                </span>
              </>
            )}
          </div>

          {hasAnyFilter && (
            <button
              onClick={clearAll}
              className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 underline-offset-4 transition-colors hover:text-orange-600 hover:underline dark:text-slate-400 dark:hover:text-orange-400"
            >
              <X className="h-3.5 w-3.5" />
              Limpar filtros
            </button>
          )}
        </div>

        {tab === "anuncios" ? (
          isLoading ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : isErrorSuppliers ? (
            /* A aba Empresas já tratava erro; esta não. Uma RPC fora do ar
               (foi o que aconteceu entre as seções 84 e 85, com
               suppliers_public_list ainda não criada) caía no mesmo
               "Nenhum anúncio encontrado" de uma busca sem resultado -- o
               visitante concluía que o catálogo estava vazio. */
            <EmptyState
              icon={AlertTriangle}
              tone="error"
              title="Não foi possível carregar os anúncios"
              description="Tente novamente em alguns instantes."
            />
          ) : filteredSuppliers.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Nenhum anúncio encontrado"
              description="Tente uma busca mais ampla ou remova alguns filtros."
            />
          ) : (
            <>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {filteredSuppliers.map((supplier, index) => (
                  <motion.div
                    key={supplier.id}
                    className="h-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.25, delay: Math.min(index, 11) * 0.02, ease: "easeOut" }}
                  >
                    <SupplierCard
                      supplier={supplier}
                      verified={!!verifiedMap[supplier.id]}
                      index={index}
                    />
                  </motion.div>
                ))}
              </div>
              {showSignupWall && <SignupWall hiddenCount={hiddenCount} />}
            </>
          )
        ) : isLoadingCompanies ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <CardSkeleton key={i} empresa />
            ))}
          </div>
        ) : isErrorCompanies ? (
          <EmptyState
            icon={AlertTriangle}
            tone="error"
            title="Não foi possível carregar as empresas"
            description="Tente novamente em alguns instantes."
          />
        ) : companies.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title="Nenhuma empresa encontrada"
            description="Tente uma busca mais ampla ou remova alguns filtros."
          />
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {companies.map((company, index) => (
                <motion.div
                  key={company.representative_supplier_id}
                  className="h-full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, delay: Math.min(index, 11) * 0.02, ease: "easeOut" }}
                >
                  {/* Sem `index`: CompanyCard nunca aceitou essa prop (quem usa
                      é o SupplierCard, para o número do catálogo no canto da
                      foto). Era prop morta passada desde sempre. */}
                  <CompanyCard
                    company={company}
                    verified={!!companyVerifiedMap[company.representative_supplier_id]}
                  />
                </motion.div>
              ))}
            </div>
            {companiesTruncated && <SignupWall sampleSize={companies.length} />}
          </>
        )}
      </div>

      <Footer />
    </div>
  );
}
