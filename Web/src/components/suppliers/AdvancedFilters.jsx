import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Star, DollarSign, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";

const STATES = [
  "AC","AL","AM","AP","BA","CE","DF","ES","GO","MA",
  "MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN",
  "RO","RR","RS","SC","SE","SP","TO"
];

const RATING_OPTIONS = [
  { label: "Qualquer avaliação", value: 0 },
  { label: "4+ estrelas", value: 4 },
  { label: "4.5+ estrelas", value: 4.5 },
  { label: "Somente 5 estrelas", value: 5 },
];

const PRICE_RANGES = [
  { label: "Qualquer valor", min: 0, max: Infinity },
  { label: "Até R$ 50", min: 0, max: 50 },
  { label: "R$ 50 – R$ 200", min: 50, max: 200 },
  { label: "R$ 200 – R$ 500", min: 200, max: 500 },
  { label: "Acima de R$ 500", min: 500, max: Infinity },
];

export default function AdvancedFilters({ filters, onChange, onClear, activeCount }) {
  const [open, setOpen] = React.useState(false);

  const set = (key, value) => onChange({ ...filters, [key]: value });

  const hasActive = activeCount > 0;

  return (
    <div className="w-full">
      {/* Toggle button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-xs font-semibold transition-colors ${
          hasActive
            ? "border-orange-500 bg-orange-500 text-white"
            : "border-slate-200 bg-white text-slate-600 hover:border-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-100"
        }`}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        Filtros avançados
        {hasActive && (
          <span className="tnum flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold text-orange-600">
            {activeCount}
          </span>
        )}
        <ChevronDown className={`w-4 h-4 ml-1 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="absolute z-30 mt-2 w-full max-w-2xl rounded-card border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display text-base font-extrabold text-slate-900 dark:text-slate-50">Filtros Avançados</h3>
              <div className="flex items-center gap-2">
                {hasActive && (
                  <Button variant="ghost" size="sm" onClick={onClear} className="text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 text-xs gap-1">
                    <X className="w-3 h-3" /> Limpar
                  </Button>
                )}
                <button onClick={() => setOpen(false)} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid sm:grid-cols-3 gap-5">
              {/* Estado */}
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Estado (UF)</p>
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                  {STATES.map((uf) => (
                    <button
                      key={uf}
                      onClick={() => set("state", filters.state === uf ? "" : uf)}
                      className={`rounded-md border px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                        filters.state === uf
                          ? "bg-orange-500 border-orange-500 text-white"
                          : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-orange-300 dark:hover:border-orange-500/50 hover:text-orange-500 dark:hover:text-orange-400"
                      }`}
                    >
                      {uf}
                    </button>
                  ))}
                </div>
              </div>

              {/* Avaliação */}
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Avaliação mínima</p>
                <div className="space-y-1.5">
                  {RATING_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => set("minRating", opt.value)}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                        filters.minRating === opt.value
                          ? "border-orange-500 bg-orange-500 font-medium text-white"
                          : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-orange-400"
                      }`}
                    >
                      {opt.value > 0 && (
                        <span className="flex">
                          {Array.from({ length: Math.floor(opt.value) }).map((_, i) => (
                            <Star key={i} className="w-3 h-3 fill-current text-current" />
                          ))}
                        </span>
                      )}
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Faixa de preço (pedido mínimo) */}
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Pedido mínimo (R$)</p>
                <div className="space-y-1.5">
                  {PRICE_RANGES.map((range, i) => (
                    <button
                      key={i}
                      onClick={() => set("priceRange", i === 0 ? null : range)}
                      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                        (i === 0 && !filters.priceRange) ||
                        (filters.priceRange?.min === range.min && filters.priceRange?.max === range.max)
                          ? "border-orange-500 bg-orange-500 font-medium text-white"
                          : "border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-orange-400"
                      }`}
                    >
                      <DollarSign className="w-3.5 h-3.5 opacity-60" />
                      {range.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex justify-end">
              <Button
                size="sm"
                onClick={() => setOpen(false)}
                className="rounded-full bg-orange-500 px-5 font-semibold text-white hover:bg-orange-600"
              >
                Aplicar filtros
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}