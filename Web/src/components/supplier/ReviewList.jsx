import React from "react";
import { MessageSquare } from "lucide-react";
import { Stars } from "../shared/Panel";

/**
 * Lista de avaliações.
 *
 * Extraída de SupplierProfile.jsx, onde o mesmo bloco de ~40 linhas estava
 * duplicado literalmente entre a visão do anúncio e a visão da empresa (a
 * única diferença era que a do anúncio nem mostrava a data). Agora é um
 * componente só -- e a data aparece nas duas.
 */
export default function ReviewList({ reviews = [], emptyMessage = "Nenhuma avaliação ainda." }) {
  if (reviews.length === 0) {
    return (
      <div className="py-8 text-center">
        <MessageSquare
          className="mx-auto mb-2 h-6 w-6 text-slate-300 dark:text-slate-600"
          strokeWidth={1.5}
        />
        <p className="text-sm text-slate-400 dark:text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {reviews.map((review) => {
        const date = review.created_at || review.created_date;
        return (
          <li key={review.id} className="py-4 first:pt-0 last:pb-0">
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-50 text-sm font-bold text-orange-600 dark:bg-orange-500/10 dark:text-orange-400">
                  {(review.reviewer_name || "A")[0].toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {review.reviewer_name || "Anônimo"}
                  </p>
                  {date && (
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                      {new Date(date).toLocaleDateString("pt-BR")}
                    </p>
                  )}
                </div>
              </div>
              <Stars value={review.rating} className="h-3.5 w-3.5" />
            </div>
            {review.comment && (
              <p className="pl-[42px] text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {review.comment}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
