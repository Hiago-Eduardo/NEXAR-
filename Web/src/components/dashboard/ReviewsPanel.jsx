import React, { useMemo, useRef, useState } from "react";
import { Star, ChevronDown, ChevronUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

// Quantas avaliações aparecem antes do "Ver todas" (seção 171).
const AVALIACOES_VISIVEIS = 3;
const TODOS = "todos";

/**
 * Avaliações recebidas no Dashboard (seção 171).
 *
 * Antes a lista mostrava TODAS as avaliações de uma vez: com 40 avaliações o
 * resto do painel ia parar lá embaixo. Agora:
 *  - resumo no topo: média e quantas avaliações de cada nota;
 *  - filtro por anúncio (só aparece com mais de um anúncio avaliado) -- a
 *    avaliação é POR ANÚNCIO, e o resumo acompanha o filtro;
 *  - as 3 mais recentes, com "Ver todas" que expande no lugar.
 */
export default function ReviewsPanel({ reviews, suppliers }) {
  const [anuncio, setAnuncio] = useState(TODOS);
  const [expandido, setExpandido] = useState(false);
  const topoRef = useRef(null);

  // Só os anúncios que TÊM avaliação entram no filtro: escolher um sem
  // nenhuma levaria a uma lista vazia.
  const anunciosAvaliados = useMemo(() => {
    const ids = new Set(reviews.map((r) => r.supplier_id));
    return suppliers.filter((s) => ids.has(s.id));
  }, [reviews, suppliers]);

  const filtradas = useMemo(
    () =>
      reviews
        .filter((r) => anuncio === TODOS || r.supplier_id === anuncio)
        .sort(
          (a, b) =>
            new Date(b.created_at || b.created_date) - new Date(a.created_at || a.created_date)
        ),
    [reviews, anuncio]
  );

  const resumo = useMemo(() => {
    const porNota = [5, 4, 3, 2, 1].map((nota) => ({
      nota,
      total: filtradas.filter((r) => Math.round(r.rating) === nota).length,
    }));
    const media = filtradas.length
      ? filtradas.reduce((s, r) => s + (Number(r.rating) || 0), 0) / filtradas.length
      : 0;
    return { porNota, media };
  }, [filtradas]);

  const visiveis = expandido ? filtradas : filtradas.slice(0, AVALIACOES_VISIVEIS);
  const escondidas = filtradas.length - AVALIACOES_VISIVEIS;

  const trocarAnuncio = (valor) => {
    setAnuncio(valor);
    setExpandido(false);
  };

  // Ao recolher, volta ao começo da seção: sem isso a pessoa fica lá
  // embaixo, onde a lista acabou de sumir.
  const alternar = () => {
    if (expandido) topoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setExpandido((v) => !v);
  };

  if (reviews.length === 0) return null;

  return (
    <Card ref={topoRef} className="mt-6 scroll-mt-6 rounded-card border border-slate-200 shadow-none dark:border-slate-800">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Star className="w-5 h-5 text-slate-400 dark:text-slate-500" />
            Avaliações Recebidas
            <span className="tnum ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {reviews.length}
            </span>
          </CardTitle>
          {anunciosAvaliados.length > 1 && (
            <Select value={anuncio} onValueChange={trocarAnuncio}>
              <SelectTrigger aria-label="Filtrar avaliações por anúncio" className="h-9 w-full rounded-card sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>Todos os anúncios</SelectItem>
                {anunciosAvaliados.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.business_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Resumo das notas */}
        <div className="grid gap-5 rounded-card border border-slate-100 p-4 dark:border-slate-800 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="text-center sm:pr-5 sm:border-r sm:border-slate-100 sm:dark:border-slate-800">
            <p className="tnum font-display text-4xl font-black text-slate-900 dark:text-slate-50">
              {resumo.media.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </p>
            <div className="mt-1 flex justify-center gap-0.5" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className={`h-4 w-4 ${
                    i < Math.round(resumo.media)
                      ? "fill-orange-500 text-orange-500"
                      : "text-slate-200 dark:text-slate-700"
                  }`}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {filtradas.length} {filtradas.length === 1 ? "avaliação" : "avaliações"}
            </p>
          </div>
          <ul className="space-y-1.5" aria-label="Distribuição das notas">
            {resumo.porNota.map(({ nota, total }) => {
              const pct = filtradas.length ? (total / filtradas.length) * 100 : 0;
              return (
                <li key={nota} className="flex items-center gap-2 text-xs">
                  <span className="tnum flex w-7 shrink-0 items-center gap-0.5 text-slate-600 dark:text-slate-300">
                    {nota}<Star className="h-3 w-3 fill-orange-500 text-orange-500" aria-hidden="true" />
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <span className="block h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="tnum w-6 shrink-0 text-right text-slate-500 dark:text-slate-400">
                    {total}
                    <span className="sr-only"> {total === 1 ? "avaliação" : "avaliações"} de {nota} estrelas</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Lista */}
        <div className="space-y-3">
          {visiveis.map((review) => {
            const supplier = suppliers.find((s) => s.id === review.supplier_id);
            const date = review.created_at || review.created_date;
            return (
              <div
                key={review.id}
                className="flex items-start gap-3 rounded-card bg-slate-50 p-4 dark:bg-slate-800/60"
              >
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-orange-600 dark:bg-orange-500/15 dark:text-orange-400">
                  {(review.reviewer_name || "A")[0].toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {review.reviewer_name || "Anônimo"}
                    </span>
                    {/* Com o filtro num anúncio só, repetir o nome dele em cada
                        item é ruído. */}
                    {supplier && anuncio === TODOS && (
                      <span className="text-xs text-slate-400 dark:text-slate-500">
                        → {supplier.business_name}
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1" aria-label={`${review.rating} de 5 estrelas`}>
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          aria-hidden="true"
                          className={`h-3.5 w-3.5 ${
                            i < review.rating
                              ? "fill-orange-500 text-orange-500"
                              : "text-slate-200 dark:text-slate-700"
                          }`}
                        />
                      ))}
                    </span>
                  </div>
                  {review.comment && (
                    <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                      {review.comment}
                    </p>
                  )}
                  {date && (
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      {new Date(date).toLocaleDateString("pt-BR")}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {escondidas > 0 && (
          <Button
            type="button"
            variant="ghost"
            onClick={alternar}
            aria-expanded={expandido}
            className="w-full gap-1.5 text-sm text-slate-500 dark:text-slate-400"
          >
            {expandido ? (
              <>Mostrar menos <ChevronUp className="h-4 w-4" /></>
            ) : (
              <>Ver todas as {filtradas.length} avaliações <ChevronDown className="h-4 w-4" /></>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
