import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ArrowRight, ChevronDown } from "lucide-react";
import { CATEGORIES } from "@/lib/categories";

// Antes cada categoria carregava um gradiente e um fundo próprios -- rosa,
// azul, esmeralda, roxo, ciano, fúcsia, amarelo, lima... dez famílias de cor
// numa seção só. Era o ponto mais "gerado por IA" do site inteiro: cor
// decorativa aplicada sem significado nenhum (a cor não dizia nada sobre a
// categoria). Agora todas compartilham o mesmo tratamento e a diferenciação
// fica por conta do ícone e do rótulo, que é onde ela sempre esteve de fato.
// Ver CONTEXTO.MD/Resumo.md seção 75.
//
// A lista (com os ícones) vem de categories.js desde a seção 213. Com 20
// categorias a grade mostra as 10 mais cheias (duas linhas no desktop) e o
// resto fica atrás de "Ver todas as categorias".
const VISIVEIS = 10;

export default function CategoryGrid() {
  // Contagem por categoria numa chamada só (suppliers_count_by_category).
  // Sem ela o grid era um menu de dez promessas em que a maioria levava a
  // "Nenhum anúncio encontrado" -- ver Resumo.md seção 87.
  const { data: counts = {} } = useQuery({
    queryKey: ["suppliers-count-by-category"],
    queryFn: () => api.catalog.countByCategory(),
  });

  // Mais cheias primeiro. `sort` é estável em JS, então categorias com a
  // mesma contagem (inclusive as zeradas) preservam a ordem original.
  const [todas, setTodas] = useState(false);
  const ordered = useMemo(
    () => [...CATEGORIES].sort((a, b) => (counts[b.key] || 0) - (counts[a.key] || 0)),
    [counts]
  );

  return (
    <section className="bg-white px-6 py-20 dark:bg-slate-950">
      <div className="mx-auto max-w-site">
        <motion.div
          className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <div>
            <h2 className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">
              Explore por categoria
            </h2>
            <p className="mt-2 text-slate-500 dark:text-slate-400">
              Fornecedores organizados por segmento, para encurtar sua busca.
            </p>
          </div>
          <Link
            to={createPageUrl("Suppliers")}
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-bold text-orange-600 transition-colors hover:text-orange-700 dark:text-orange-400"
          >
            Ver todos os fornecedores
            <ArrowRight className="h-4 w-4" />
          </Link>
        </motion.div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          {(todas ? ordered : ordered.slice(0, VISIVEIS)).map((cat, index) => {
            const total = counts[cat.key] || 0;
            const isEmpty = total === 0;
            return (
              <motion.div
                key={cat.key}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: Math.min(index, 9) * 0.03, duration: 0.25 }}
              >
                {/* Categoria vazia continua clicável (a busca de lá explica o
                    vazio), mas fica mais discreta -- e sem selo, para não
                    estampar "0" em metade do grid. */}
                <Link
                  to={createPageUrl("Suppliers") + `?category=${cat.key}`}
                  title={cat.hint || undefined}
                  className={`group flex h-full items-center gap-3 rounded-card border p-4 transition-all hover:-translate-y-0.5 hover:border-orange-300 hover:bg-orange-50 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10 ${
                    isEmpty
                      ? "border-slate-100 dark:border-slate-800/60"
                      : "border-slate-200 dark:border-slate-800"
                  }`}
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-card transition-colors group-hover:bg-orange-500 group-hover:text-white ${
                      isEmpty
                        ? "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500"
                        : "bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400"
                    }`}
                  >
                    <cat.icon className="h-5 w-5" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <h3
                      className={`text-sm font-bold leading-tight transition-colors group-hover:text-orange-700 dark:group-hover:text-orange-400 ${
                        isEmpty
                          ? "text-slate-400 dark:text-slate-500"
                          : "text-slate-800 dark:text-slate-100"
                      }`}
                    >
                      {cat.label}
                    </h3>
                    {!isEmpty && (
                      <p className="tnum mt-0.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
                        {total} {total === 1 ? "anúncio" : "anúncios"}
                      </p>
                    )}
                  </div>
                </Link>
              </motion.div>
            );
          })}
        </div>

        {ordered.length > VISIVEIS && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setTodas((v) => !v)}
              aria-expanded={todas}
              className="inline-flex items-center gap-1.5 rounded-card border border-slate-200 px-4 py-2 text-sm font-bold text-slate-700 transition-colors hover:border-orange-300 hover:text-orange-700 dark:border-slate-800 dark:text-slate-200 dark:hover:border-orange-500/40 dark:hover:text-orange-400"
            >
              {todas ? "Mostrar menos" : `Ver todas as categorias (${ordered.length})`}
              <ChevronDown className={`h-4 w-4 transition-transform ${todas ? "rotate-180" : ""}`} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
