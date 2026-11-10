import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Star, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/api/client";
import SupplierCard from "../shared/SupplierCard";

const PLAN_RANK = { premium: 0, profissional: 1, basico: 2 };
const AUTOPLAY_MS = 5000;

// Plano pago só entra como critério de ORDENAÇÃO/desempate dentro da mesma
// categoria (prioriza quem paga, mas não exclui quem tem boa avaliação e
// ainda está no básico) -- decidido com o usuário como meio-termo entre
// "só quem paga aparece" e "só avaliação importa".
function isBetterFeatured(a, b) {
  const planDiff = (PLAN_RANK[a.plan] ?? 3) - (PLAN_RANK[b.plan] ?? 3);
  if (planDiff !== 0) return planDiff < 0;
  if ((a.rating || 0) !== (b.rating || 0)) return (a.rating || 0) > (b.rating || 0);
  return (a.total_reviews || 0) > (b.total_reviews || 0);
}

/** Comparador derivado de isBetterFeatured, para usar direto em .sort(). */
function compareFeatured(a, b) {
  if (isBetterFeatured(a, b)) return -1;
  if (isBetterFeatured(b, a)) return 1;
  return 0;
}

// Mínimo de cartões na seção. Abaixo disso a vitrine parece quebrada --
// título grande de "Destaques" com um cartão solitário e dois buracos.
const MIN_FEATURED = 3;

const NEW_BADGE_DAYS = 14;

// Selo "Novo" -- dado real (created_at), não estimativa. Sinaliza atividade
// recente na plataforma sem inventar número nenhum.
function isRecentlyCreated(createdAt) {
  if (!createdAt) return false;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs >= 0 && ageMs <= NEW_BADGE_DAYS * 24 * 60 * 60 * 1000;
}

// 1 item por breakpoint no mobile, 3 no tablet/desktop -- precisa ser um
// número fixo (não um grid fluido) pra paginar o carrossel corretamente.
function useItemsPerView() {
  const [itemsPerView, setItemsPerView] = useState(
    () => (typeof window !== "undefined" && window.innerWidth >= 768 ? 3 : 1)
  );
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setItemsPerView(query.matches ? 3 : 1);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return itemsPerView;
}

export default function FeaturedSuppliers({ suppliers, isLoading }) {
  // Um destaque por categoria (o melhor avaliado dentro dela) -- limite
  // natural de no máximo CATEGORIES.length (10) itens, nunca precisa de um
  // cap arbitrário separado.
  const featured = useMemo(() => {
    const all = suppliers || [];

    const bestByCategory = new Map();
    for (const s of all) {
      const current = bestByCategory.get(s.category);
      if (!current || isBetterFeatured(s, current)) {
        bestByCategory.set(s.category, s);
      }
    }
    const picked = Array.from(bestByCategory.values()).sort(compareFeatured);

    // "1 por categoria" é boa regra de DIVERSIDADE quando há catálogo, mas
    // com catálogo pequeno ela esvazia a seção: dois fornecedores na mesma
    // categoria viravam UM único cartão numa grade de três colunas (ver
    // Resumo.md seção 88). Quando não há categorias suficientes, completa
    // com os próximos melhores que ficaram de fora.
    //
    // Com o catálogo cheio isso nunca entra em ação -- havendo 3+ categorias
    // ocupadas, o comportamento é exatamente o de antes.
    if (picked.length >= MIN_FEATURED) return picked;

    const alreadyPicked = new Set(picked.map((s) => s.id));
    const fillers = all.filter((s) => !alreadyPicked.has(s.id)).sort(compareFeatured);

    return [...picked, ...fillers.slice(0, MIN_FEATURED - picked.length)];
  }, [suppliers]);

  // Selo "Verificado": via RPC segura (assinatura real do DONO de cada anúncio), nunca
  // supplier.verified isolado. Ver suppliers_verified_status em supabase/rls-policies.sql.
  // Hooks precisam rodar sempre, antes dos returns antecipados abaixo (loading/vazio).
  const featuredIds = useMemo(() => featured.map((s) => s.id), [featured]);
  const { data: verifiedMap = {} } = useQuery({
    queryKey: ["suppliers-verified", featuredIds],
    queryFn: () => api.verification.getForSuppliers(featuredIds),
    enabled: featuredIds.length > 0,
  });

  const itemsPerView = useItemsPerView();
  const pageCount = Math.max(1, Math.ceil(featured.length / itemsPerView));
  const [pageIndex, setPageIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (pageIndex >= pageCount) setPageIndex(0);
  }, [pageCount, pageIndex]);

  // Autoplay pausa no hover e respeita prefers-reduced-motion -- carrossel
  // 100% automático sem controle manual é ruim pra quem tem sensibilidade a
  // movimento e some antes de dar tempo de ler; por isso também tem
  // setas + bolinhas clicáveis abaixo.
  useEffect(() => {
    if (pageCount <= 1 || isPaused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const interval = setInterval(() => {
      setPageIndex((i) => (i + 1) % pageCount);
    }, AUTOPLAY_MS);
    return () => clearInterval(interval);
  }, [pageCount, isPaused]);

  if (isLoading) {
    return (
      <section className="bg-slate-50 px-6 py-20 dark:bg-slate-900/40">
        <div className="max-w-site mx-auto">
          <div className="grid gap-5 md:grid-cols-3">
            {[1, 2, 3].map((i) => (
              // h-[32rem] ~ altura do SupplierCard com a imagem 2:1 (509px
              // medidos, seção 178). Era h-72 (288px): a seção "crescia" ao
              // carregar e empurrava a página.
              <div key={i} className="h-[32rem] animate-pulse rounded-card bg-slate-100 dark:bg-slate-800" />
            ))}
          </div>
        </div>
      </section>
    );
  }

  // Antes só desaparecia da página (return null) quando não havia fornecedor
  // premium/profissional suficiente -- deixava um buraco silencioso na Home.
  // Agora esse caso renderiza um estado vazio com CTA em vez de nada.
  if (featured.length === 0) {
    return (
      <section className="bg-slate-50 px-6 py-20 dark:bg-slate-900/40">
        <div className="max-w-3xl mx-auto text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-orange-50 dark:bg-orange-500/10">
            <Star className="h-6 w-6 text-orange-500" />
          </div>
          <h2 className="mb-3 font-display text-2xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-3xl">
            Ainda não temos fornecedores em destaque
          </h2>
          <p className="mb-8 text-slate-500 dark:text-slate-400">
            O melhor avaliado de cada categoria aparece aqui. Seja um dos primeiros a se destacar no NEXAR.
          </p>
          <Link to={createPageUrl("Register")}>
            <Button className="gap-2 rounded-card bg-orange-500 font-bold text-white hover:bg-orange-600">
              Cadastrar como Fornecedor
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </section>
    );
  }

  const pageItems = featured.slice(pageIndex * itemsPerView, pageIndex * itemsPerView + itemsPerView);
  const goPrev = () => setPageIndex((i) => (i - 1 + pageCount) % pageCount);
  const goNext = () => setPageIndex((i) => (i + 1) % pageCount);

  return (
    <section
      className="bg-slate-50 px-6 py-20 dark:bg-slate-900/40"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="max-w-site mx-auto">
        <motion.div
          className="mb-10 flex items-end justify-between gap-4"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <div>
            <h2 className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">
              Fornecedores em Destaque
            </h2>
            <p className="mt-2 text-slate-500 dark:text-slate-400">
              O melhor avaliado de cada categoria
            </p>
          </div>
          <div className="hidden md:flex items-center gap-3">
            {pageCount > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goPrev}
                  aria-label="Grupo anterior"
                  className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-orange-600 dark:hover:text-orange-400 hover:border-orange-200 dark:hover:border-orange-900/50 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  aria-label="Próximo grupo"
                  className="w-9 h-9 rounded-full border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-orange-600 dark:hover:text-orange-400 hover:border-orange-200 dark:hover:border-orange-900/50 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
            <Link to={createPageUrl("Suppliers")}>
              <Button variant="outline" className="gap-2 rounded-card font-bold">
                Ver todos
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
          </div>
        </motion.div>

        <AnimatePresence mode="wait">
          {/* A grade acompanha a quantidade real. Fixa em 3 colunas, uma
              página com 1 ou 2 cartões deixava buracos à direita e os
              cartões pareciam esquecidos num canto. */}
          <motion.div
            key={pageIndex}
            className={`grid gap-5 ${
              pageItems.length === 1
                ? "max-w-sm md:grid-cols-1"
                : pageItems.length === 2
                  ? "max-w-3xl md:grid-cols-2"
                  : "md:grid-cols-3"
            }`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.4 }}
          >
            {pageItems.map((supplier) => (
              <SupplierCard
                key={supplier.id}
                supplier={supplier}
                verified={!!verifiedMap[supplier.id]}
                isNew={isRecentlyCreated(supplier.created_at)}
              />
            ))}
          </motion.div>
        </AnimatePresence>

        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-2 mt-8">
            {Array.from({ length: pageCount }).map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPageIndex(i)}
                aria-label={`Ir para o grupo ${i + 1}`}
                className={`h-2 rounded-full transition-all ${
                  i === pageIndex
                    ? "w-6 bg-orange-500"
                    : "w-2 bg-slate-300 dark:bg-slate-700 hover:bg-slate-400 dark:hover:bg-slate-600"
                }`}
              />
            ))}
          </div>
        )}

        <div className="mt-8 text-center md:hidden">
          <Link to={createPageUrl("Suppliers")}>
            <Button variant="outline" className="gap-2 rounded-card font-bold">
              Ver todos os fornecedores
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
