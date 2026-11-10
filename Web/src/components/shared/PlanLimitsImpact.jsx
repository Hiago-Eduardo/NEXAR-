import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { summarizePlanPreview } from "@/lib/planLimitsPreview";

/**
 * "O que muda nos seus anúncios e produtos" -- dentro dos diálogos de troca
 * de plano (Planos) e de cancelamento (PlanManagerCard). Pergunta ao banco
 * (preview_my_plan_change) pela MESMA regra que a central vai aplicar, com o
 * nome de cada item. `planId` null = ficar sem plano.
 *
 * Não renderiza nada quando nada muda ou quando a prévia falha: ela é
 * informação a mais, nunca pode impedir a pessoa de confirmar.
 *
 * Fica FORA do AlertDialogDescription de quem usa: aquele é um <p>, e isto
 * tem lista.
 */
export default function PlanLimitsImpact({ planId, note, enabled = true }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["plan-limits-preview", planId ?? "none"],
    queryFn: () => api.planLimits.previewChange(planId ?? null),
    enabled,
    staleTime: 0,
    retry: false,
  });

  if (!enabled || isError) return null;
  if (isLoading) {
    return <p className="text-sm text-slate-400 dark:text-slate-500">Conferindo seus anúncios e produtos…</p>;
  }

  const lines = summarizePlanPreview(data);
  if (lines.length === 0) return null;

  return (
    <div className="rounded-card border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
      <p className="mb-2 font-semibold text-slate-900 dark:text-slate-100">O que muda nos seus anúncios e produtos</p>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={`${line.direction}-${line.kind}`}>
            <strong className={line.direction === "suspend" ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}>
              {line.direction === "suspend"
                ? line.count === 1 ? "Sai do ar" : "Saem do ar"
                : line.count === 1 ? "Volta ao ar" : "Voltam ao ar"}
            </strong>{" "}
            {line.label}: {line.names}
          </li>
        ))}
      </ul>
      {note && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{note}</p>}
    </div>
  );
}
