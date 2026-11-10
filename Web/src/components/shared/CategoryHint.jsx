import React from "react";
import { categoryHint } from "@/lib/categories";
import { cn } from "@/lib/utils";

// Dica da categoria escolhida, abaixo do Select (seção 214). Fica fora da
// lista suspensa de propósito: o SelectItem do shadcn repete o conteúdo no
// campo fechado, e a dica iria parar dentro dele.
export default function CategoryHint({ category, className = "" }) {
  const hint = categoryHint(category);
  if (!hint) return null;
  return (
    <p className={cn("mt-1.5 text-xs text-slate-500 dark:text-slate-400", className)}>
      {hint}
    </p>
  );
}
