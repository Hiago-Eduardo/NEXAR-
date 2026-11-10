import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Star, MapPin, BadgeCheck, ArrowRight, Package, Lock } from "lucide-react";
import { CATEGORY_LABELS } from "@/lib/categories";
import { useAuth } from "@/lib/AuthContext";

/**
 * Cartão de EMPRESA (aba "Empresas").
 *
 * Fica na mesma página do cartão de anúncio, então segue a mesma gramática
 * aquecida (ver CONTEXTO.MD/Resumo.md seção 72) -- se só o cartão de anúncio
 * fosse aquecido, a página ficaria com duas linguagens. A diferença
 * deliberada continua: aqui o avatar é o protagonista (é uma conta, não um
 * anúncio), sobre uma faixa quente em vez de capa.
 *
 * DESLOGADO O DESTINO MUDA (decisão da seção 101). O perfil da empresa está
 * atrás do muro desde a seção 84, então TODO cartão desta aba levava um
 * visitante sem conta para a mesma parede -- ele navegava a aba inteira e
 * 100% dos caminhos terminavam em muro, sem nenhum aviso antes do clique.
 * Agora o cartão declara a condição (cadeado + rodapé "Criar conta para
 * ver") e o clique vai direto ao cadastro. A busca continua livre e o acervo
 * continua visível: o que muda é só o visitante saber o preço antes de bater
 * na parede.
 */
export default function CompanyCard({ company, verified = false }) {
  const { isAuthenticated } = useAuth();
  const profileUrl = `${createPageUrl("SupplierProfile")}?id=${company.representative_supplier_id}&view=empresa`;
  const location = [company.city, company.state].filter(Boolean).join(" - ");
  const categoryLabel =
    CATEGORY_LABELS[company.segment || company.category] || company.segment || company.category;

  const destination = isAuthenticated ? profileUrl : createPageUrl("Register");

  return (
    <Link
      to={destination}
      aria-label={
        isAuthenticated
          ? `Ver perfil de ${company.company_name}`
          : `Criar conta para ver o perfil de ${company.company_name}`
      }
      className="listing-card group flex h-full flex-col"
    >
      {/* Faixa quente + avatar sobreposto. O avatar ganhou raio e anel branco
          para não ficar com aspecto de bloco recortado. */}
      <div className="relative h-20 bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-500/15 dark:to-slate-800">
        {company.cover_url && (
          <img src={company.cover_url} alt="" className="h-full w-full object-cover" />
        )}
        {/* Selo e cadeado dividem o canto -- uma empresa verificada vista por
            um visitante sem conta mostra os dois, então não podem disputar a
            mesma posição absoluta. */}
        <div className="absolute right-3 top-3 flex items-center gap-1.5">
          {verified && (
            <span className="flex items-center gap-1 rounded-full bg-orange-500 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm">
              <BadgeCheck className="h-3.5 w-3.5" />
              Verificado
            </span>
          )}
          {!isAuthenticated && (
            <span
              title="Perfil completo disponível para quem tem conta"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/80 text-white backdrop-blur-sm dark:bg-white/90 dark:text-slate-900"
            >
              <Lock className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="absolute -bottom-7 left-4 h-14 w-14 overflow-hidden rounded-card ring-4 ring-white dark:ring-slate-900">
          {company.avatar_url ? (
            <img src={company.avatar_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-orange-50 dark:bg-slate-800">
              <span className="font-display text-xl font-black text-orange-400 dark:text-orange-500/60">
                {company.company_name?.[0]?.toUpperCase()}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4 pt-9">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 font-display text-lg font-extrabold leading-tight text-slate-900 transition-colors group-hover:text-orange-600 dark:text-slate-50 dark:group-hover:text-orange-400">
            {company.company_name}
          </h3>
          {company.rating_avg > 0 && (
            <span className="tnum flex shrink-0 items-center gap-1 text-sm font-bold text-slate-900 dark:text-slate-100">
              <Star className="h-3.5 w-3.5 fill-orange-500 text-orange-500" />
              {Number(company.rating_avg).toFixed(1)}
            </span>
          )}
        </div>

        {categoryLabel && (
          <span className="mb-3 w-fit truncate rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 dark:bg-orange-500/10 dark:text-orange-400">
            {categoryLabel}
          </span>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1.5">
            <Package className="h-3.5 w-3.5 text-orange-500" />
            <span className="tnum font-semibold text-slate-700 dark:text-slate-200">
              {company.ad_count}
            </span>
            anúncio{company.ad_count !== 1 ? "s" : ""}
          </span>
          {location && (
            <span className="flex min-w-0 items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-orange-500" />
              <span className="truncate">{location}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-1.5 border-t border-slate-200 py-2.5 text-xs font-bold text-orange-600 transition-colors group-hover:bg-orange-50 dark:border-slate-800 dark:text-orange-400 dark:group-hover:bg-orange-500/10">
        {isAuthenticated ? "Ver perfil da empresa" : "Criar conta para ver"}
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
