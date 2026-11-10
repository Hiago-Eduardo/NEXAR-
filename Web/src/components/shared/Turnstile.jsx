import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { useTheme } from "@/lib/ThemeContext";
import {
  CAPTCHA_INITIAL, captchaAllowsSubmit, captchaHint, captchaReducer, loadTurnstileScript, resolveSiteKey,
} from "@/lib/turnstile";

/**
 * Widget do Cloudflare Turnstile (Resumo.md §228). Use pelo hook
 * `useCaptcha()`, não direto: o hook garante que o token, de USO ÚNICO,
 * é descartado e o desafio reiniciado a cada envio.
 *
 *   const captcha = useCaptcha();
 *   ...
 *   {captcha.widget}
 *   <Button disabled={!captcha.canSubmit}>...</Button>
 *   await supabase.auth.signInWithPassword({ email, password,
 *     options: { captchaToken: captcha.consume() } });
 */
function TurnstileWidget({ siteKey, action, onEvent, apiRef, retryKey }) {
  const containerRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const { resolvedTheme } = useTheme();
  // O tema do widget não muda depois de renderizado: trocar o tema do site
  // re-renderiza o widget (o efeito abaixo depende dele).
  const theme = resolvedTheme === "dark" ? "dark" : "light";

  useEffect(() => {
    let cancelado = false;
    let widgetId = null;
    const emit = (event) => {
      if (!cancelado) onEventRef.current(event);
    };

    loadTurnstileScript()
      .then((turnstile) => {
        if (cancelado || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action,
          theme,
          size: "flexible",
          language: "pt-br",
          "refresh-expired": "auto",
          callback: (token) => emit({ type: "success", token }),
          "expired-callback": () => emit({ type: "expired" }),
          "timeout-callback": () => emit({ type: "expired" }),
          // true = erro tratado aqui (a Cloudflare não relança no console).
          "error-callback": () => {
            emit({ type: "error" });
            return true;
          },
        });
        apiRef.current = {
          reset: () => {
            try {
              turnstile.reset(widgetId);
            } catch {
              // widget já removido (troca de página): nada a reiniciar.
            }
          },
        };
        emit({ type: "rendered" });
      })
      .catch(() => emit({ type: "unavailable" }));

    return () => {
      // Widget saindo da tela (voltar de etapa, fechar o formulário, trocar
      // o tema): o token dele morre junto -- sem isto o hook guardaria um
      // token que vence em 5 min sem ninguém avisar.
      emit({ type: "reset" });
      cancelado = true;
      apiRef.current = null;
      const turnstile = /** @type {any} */ (window).turnstile;
      if (widgetId != null && turnstile) {
        try {
          turnstile.remove(widgetId);
        } catch {
          // já removido
        }
      }
    };
  }, [siteKey, action, theme, retryKey, apiRef]);

  // min-h reserva o espaço do widget (65 px) e evita o formulário "pular".
  return <div ref={containerRef} className="min-h-[65px] w-full" data-testid="turnstile-widget" />;
}

// `enabled: false` desliga o widget sem quebrar a regra dos hooks (ex.: o
// orçamento, que só usa CAPTCHA com VITE_TURNSTILE_CONTACT_REQUIRED=true).
/** @param {{ action?: string, enabled?: boolean }} [options] */
export function useCaptcha({ action, enabled = true } = {}) {
  const siteKey = useMemo(() => (enabled ? resolveSiteKey() : null), [enabled]);
  const [state, dispatch] = useReducer(
    captchaReducer,
    siteKey ? CAPTCHA_INITIAL : { status: "disabled", token: null },
  );
  const [retryKey, setRetryKey] = useState(0);
  const apiRef = useRef(null);
  const tokenRef = useRef(null);
  tokenRef.current = state.token;

  // Entrega o token para UMA chamada e já reinicia o desafio: o mesmo token
  // nunca vai em duas requisições, nem depois de erro.
  const consume = useCallback(() => {
    if (!siteKey) return undefined;
    const token = tokenRef.current;
    tokenRef.current = null;
    dispatch({ type: "consumed" });
    apiRef.current?.reset();
    return token || undefined;
  }, [siteKey]);

  // Recomeça do zero (script incluído) -- botão "Tentar de novo".
  const retry = useCallback(() => {
    dispatch({ type: "reset" });
    setRetryKey((k) => k + 1);
  }, []);

  const hint = captchaHint(state);
  const podeTentarDeNovo = state.status === "unavailable" || state.status === "error";

  const widget = siteKey ? (
    <div className="space-y-2">
      <TurnstileWidget siteKey={siteKey} action={action} onEvent={dispatch} apiRef={apiRef} retryKey={retryKey} />
      {state.status === "verified" ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <ShieldCheck className="h-3.5 w-3.5" /> Verificação concluída.
        </p>
      ) : hint ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role={podeTentarDeNovo ? "alert" : "status"}
            className={`text-xs ${podeTentarDeNovo ? "text-red-600 dark:text-red-400" : "text-slate-500 dark:text-slate-400"}`}>
            {hint}
          </p>
          {podeTentarDeNovo && (
            <button type="button" onClick={retry}
              className="inline-flex items-center gap-1 text-xs font-medium text-orange-600 hover:text-orange-700 dark:text-orange-400">
              <RefreshCw className="h-3.5 w-3.5" /> Tentar de novo
            </button>
          )}
        </div>
      ) : null}
    </div>
  ) : null;

  return {
    enabled: !!siteKey,
    status: state.status,
    canSubmit: captchaAllowsSubmit(state),
    consume,
    retry,
    widget,
  };
}
