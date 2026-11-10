import React, { useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { passwordChecks } from "@/lib/password";

/**
 * Campo de senha com o olho para mostrar/esconder (seção 176). Mesmas props
 * de <Input>; `leftIcon` opcional para as telas de Login/Register, que já
 * têm o cadeado à esquerda.
 */
export function PasswordInput({ className, leftIcon, ...props }) {
  const [visivel, setVisivel] = useState(false);
  return (
    <div className="relative">
      {leftIcon}
      <Input {...props} type={visivel ? "text" : "password"} className={cn("pr-10", className)} />
      <button
        type="button"
        onClick={() => setVisivel((v) => !v)}
        aria-label={visivel ? "Esconder senha" : "Mostrar senha"}
        aria-pressed={visivel}
        disabled={props.disabled}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-50 dark:hover:text-slate-200"
      >
        {visivel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Requisitos da senha nova marcados enquanto a pessoa digita. `extras`
 * acrescenta regras da tela (ex.: "Diferente da senha atual", "As senhas
 * conferem"), no mesmo formato { key, label, ok }.
 */
export function PasswordRequirements({ senha, extras = [], id }) {
  const itens = [...passwordChecks(senha), ...extras];
  return (
    <ul id={id} className="mt-2 space-y-1" aria-live="polite">
      {itens.map((item) => (
        <li
          key={item.key}
          className={cn(
            "flex items-center gap-2 text-xs",
            item.ok ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] leading-none",
              item.ok
                ? "border-emerald-500 bg-emerald-500 text-white"
                : "border-slate-300 dark:border-slate-600"
            )}
          >
            {item.ok && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
          </span>
          {item.label}
          <span className="sr-only">{item.ok ? " — atendido" : " — pendente"}</span>
        </li>
      ))}
    </ul>
  );
}
