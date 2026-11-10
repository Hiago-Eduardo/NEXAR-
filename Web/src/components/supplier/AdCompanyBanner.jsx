import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, BadgeCheck, MapPin, CalendarDays, Star } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Faixa de identidade da empresa no topo do anúncio -- o bloco escuro do
 * template (CONTEXTO.MD/image.png).
 *
 * SUBSTITUI A CAPA. Antes o topo era uma foto qualquer esticada em 256px
 * (`Cover`), que depois da galeria virou redundante: a mesma imagem aparecia
 * no topo e na galeria, e quando o fornecedor subia um print aleatório o
 * cabeçalho inteiro virava aquele print.
 *
 * Aqui o topo passa a DIZER algo: de quem é o anúncio, se é verificado, qual
 * o plano, onde fica, desde quando está no NEXAR e como é avaliado. É a
 * informação que decide se vale continuar lendo.
 *
 * SEM FOTO DE FUNDO, de propósito. O template usa uma foto sangrando à
 * direita, mas lá ela é uma imagem institucional diferente das do produto.
 * Aqui a única foto disponível seria a primeira da galeria -- a mesma que
 * aparece logo abaixo, em tamanho maior. Repetir não acrescenta, e com print
 * de tela no lugar de foto de negócio (o caso real hoje) fica pior.
 *
 * NÃO INCLUI a contagem de anúncios da empresa ("+500 anúncios" no template):
 * ela vem de company_public_suppliers, que só é consultada na visão de
 * EMPRESA porque aquela visão está atrás do cadastro (seção 84). Trazer para
 * cá exigiria mexer nesse portão, e não é decisão para tomar de passagem.
 */
export default function AdCompanyBanner({
  supplier,
  categoria,
  verified,
  planBadge,
  onBack,
  backLabel = "Voltar",
}) {
  const ano = supplier.created_at ? new Date(supplier.created_at).getFullYear() : null;
  const nota = Number(supplier.rating) > 0 ? Number(supplier.rating) : null;

  return (
    <div className="bg-slate-900 dark:bg-slate-950">
      <div className="mx-auto max-w-site px-6 pb-7 pt-5">
        <Button
          onClick={onBack}
          variant="secondary"
          className="mb-5 h-9 gap-2 rounded-full bg-white/10 text-sm font-semibold text-white hover:bg-white/20"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Button>

        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            {/* Caixa branca mesmo no tema escuro: logo de empresa quase sempre
                é feito para fundo claro, e sobre o slate-900 muitos somem. */}
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-card bg-white p-1 md:h-20 md:w-20">
              {supplier.logo_url ? (
                <img src={supplier.logo_url} alt="" className="h-full w-full rounded-[10px] object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-[10px] bg-orange-50">
                  <span className="font-display text-2xl font-black text-orange-400 md:text-3xl">
                    {supplier.business_name?.[0]?.toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-xl font-black leading-tight text-white md:text-2xl">
                  {supplier.business_name}
                </h1>
                {verified && (
                  <BadgeCheck className="h-5 w-5 shrink-0 text-orange-500" aria-label="Empresa verificada" />
                )}
                {planBadge && (
                  <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${planBadge.className}`}>
                    {planBadge.label}
                  </span>
                )}
              </div>

              {categoria && (
                <p className="mt-1 truncate text-sm text-slate-300">{categoria}</p>
              )}

              {/* Cada item só aparece se existir -- mesma regra do cartão da
                  listagem (seção 138). Sem local e sem data, a linha some
                  inteira em vez de mostrar rótulos vazios. */}
              {(supplier.location || ano) && (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                  {supplier.location && (
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5" />
                      {supplier.location}
                    </span>
                  )}
                  {ano && (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5" />
                      No NEXAR desde {ano}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
            {verified && (
              <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-200">
                <BadgeCheck className="h-4 w-4 text-orange-500" />
                Empresa verificada
              </span>
            )}
            {nota && (
              <span className="inline-flex items-center gap-2 text-sm font-medium text-slate-200">
                <Star className="h-4 w-4 fill-orange-500 text-orange-500" />
                <span className="tnum">{nota.toFixed(1)}</span>
                {supplier.total_reviews > 0 && (
                  <span className="text-slate-400">
                    ({supplier.total_reviews} {supplier.total_reviews === 1 ? "avaliação" : "avaliações"})
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Trilha de navegação. Categoria é PLANA no NEXAR -- não há subcategoria
 *  como no template ("Tratores Agrícolas" dentro de "Agro Máquinas"), então
 *  são quatro níveis e não cinco. Inventar um nível seria mentir sobre a
 *  estrutura do catálogo. */
export function AdBreadcrumb({ categoria, categoriaUrl, nome }) {
  return (
    <nav aria-label="Trilha de navegação" className="mx-auto max-w-site px-6 pt-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <li><Link to="/" className="hover:text-orange-600 dark:hover:text-orange-400">Início</Link></li>
        <li aria-hidden className="text-slate-300 dark:text-slate-600">›</li>
        <li><Link to="/Suppliers" className="hover:text-orange-600 dark:hover:text-orange-400">Fornecedores</Link></li>
        {categoria && (
          <>
            <li aria-hidden className="text-slate-300 dark:text-slate-600">›</li>
            <li>
              <Link to={categoriaUrl} className="hover:text-orange-600 dark:hover:text-orange-400">
                {categoria}
              </Link>
            </li>
          </>
        )}
        <li aria-hidden className="text-slate-300 dark:text-slate-600">›</li>
        <li aria-current="page" className="truncate font-medium text-slate-700 dark:text-slate-200">
          {nome}
        </li>
      </ol>
    </nav>
  );
}
