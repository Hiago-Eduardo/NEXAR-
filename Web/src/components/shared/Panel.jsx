import React from "react";
import { cn } from "@/lib/utils";

/**
 * Painel padrão das telas de perfil (anúncio e empresa).
 *
 * Substitui o `<Card className="rounded-2xl border-0 shadow-sm">` que se
 * repetia em toda seção -- era literalmente a assinatura visual que dava ar
 * de template (ver CONTEXTO.MD/Resumo.md seções 71-73). Aqui: superfície
 * plana, borda quente de 1px, raio do sistema (rounded-card) e o título
 * sempre separado do corpo por um fio, em vez de sombra.
 */
export function Panel({ title, icon: Icon, count, action, children, bodyClassName, className }) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-card border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
        className
      )}
    >
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          {/* leading-snug + items-start: titulo longo quebra em duas linhas,
              e com a entrelinha padrao de um text-base extrabold elas ficavam
              coladas. items-start mantem o icone alinhado a PRIMEIRA linha. */}
          <h2 className="flex items-start gap-2 font-display text-base font-extrabold leading-snug text-slate-900 dark:text-slate-50">
            {Icon && <Icon className="h-4 w-4 text-orange-500" />}
            {title}
            {typeof count === "number" && (
              <span className="tnum rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {count}
              </span>
            )}
          </h2>
          {action}
        </header>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * Fileira de estrelas. Antes cada tela desenhava o seu próprio laço de 5
 * estrelas em âmbar -- agora é um só componente, e em laranja (o âmbar era
 * mais uma cor de destaque competindo, ver seção 71).
 */
export function Stars({ value = 0, className = "h-4 w-4" }) {
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <svg
          key={i}
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={cn(
            className,
            i < Math.round(value)
              ? "fill-orange-500 text-orange-500"
              : "fill-slate-200 text-slate-200 dark:fill-slate-700 dark:text-slate-700"
          )}
        >
          <path d="M12 2l2.9 6.2 6.6.9-4.8 4.7 1.2 6.7L12 17.3 6.1 20.5l1.2-6.7L2.5 9.1l6.6-.9L12 2z" />
        </svg>
      ))}
    </span>
  );
}
