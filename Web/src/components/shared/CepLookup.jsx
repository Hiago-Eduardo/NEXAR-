import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, AlertTriangle, CheckCircle, X } from "lucide-react";
import { isValidCEP, normalizeCEP, formatCEP } from "@/lib/cep";
import { applyFillProposals } from "@/api/cnpjLookup";
import {
  lookupCEP, CepLookupError, buildCepFillProposals, cepLookupStateFor, CEP_LOOKUP_IDLE,
} from "@/api/cepLookup";

/**
 * Consulta de CEP no ViaCEP para preencher cidade e UF (Register e Minha
 * Conta). Mesmo comportamento da consulta de CNPJ (CnpjLookup.jsx): mostra
 * antes de preencher, nunca sobrescreve em silêncio -- inclusive o que a
 * consulta de CNPJ já preencheu --, resultado some quando o CEP muda.
 * Rua e bairro só aparecem no painel; não são gravados (seção 205).
 *
 * SEM BOTÃO (seção 206): consulta sozinha quando o CEP fica com 8 dígitos,
 * AUTO_DELAY_MS depois da última mudança. `auto` liga e desliga -- Minha
 * Conta só liga depois que a pessoa mexe no CEP, para não consultar o CEP
 * salvo toda vez que abre a edição. Voltar a um CEP já consultado reabre o
 * resultado pelo cache de cepLookup.js, sem nova requisição. Carregando =
 * spinner dentro do campo (CepLookupSpinner); falha de serviço = "Tentar de
 * novo" na mensagem, único caso em que a pessoa precisa agir.
 */

const AUTO_DELAY_MS = 600;

export function useCepLookup(cep, { auto = false } = {}) {
  const atual = normalizeCEP(cep);
  const valid = isValidCEP(cep);
  const [state, setState] = useState(CEP_LOOKUP_IDLE);

  const vigente = cepLookupStateFor(state, atual);

  const lookup = useCallback(async () => {
    if (!valid) {
      setState({ status: "error", cep: atual, data: null, error: new CepLookupError("invalid") });
      return;
    }
    setState({ status: "loading", cep: atual, data: null, error: null });
    try {
      const data = await lookupCEP(atual);
      setState((s) => (s.cep === atual ? { status: "success", cep: atual, data, error: null } : s));
    } catch (error) {
      const erro = error instanceof CepLookupError ? error : new CepLookupError("unavailable");
      setState((s) => (s.cep === atual ? { status: "error", cep: atual, data: null, error: erro } : s));
    }
  }, [atual, valid]);

  // Dispara a cada CEP completo novo. Não precisa lembrar quais já foram:
  // o efeito só roda quando o valor MUDA (fechar o painel não reconsulta), e
  // um CEP repetido sai do cache sem ir à rede.
  useEffect(() => {
    if (!auto || !valid) return undefined;
    const timer = setTimeout(lookup, AUTO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [auto, valid, lookup]);

  const marcarAplicado = () => setState((s) => ({ ...s, status: "applied" }));
  const descartar = () => setState(CEP_LOOKUP_IDLE);

  return { ...vigente, valid, lookup, marcarAplicado, descartar };
}

// Spinner dentro do campo, no canto direito (o Input precisa de pr-9 e de
// um pai `relative`).
export function CepLookupSpinner({ consulta }) {
  if (consulta.status !== "loading") return null;
  return (
    <Loader2
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400"
      aria-label="Consultando CEP"
    />
  );
}

function Linha({ rotulo, valor }) {
  if (!valor) return null;
  return (
    <div className="grid gap-x-2 sm:grid-cols-[8.5rem_1fr]">
      <dt className="text-slate-500 dark:text-slate-400">{rotulo}</dt>
      <dd className="text-slate-800 dark:text-slate-100">{valor}</dd>
    </div>
  );
}

function Resultado({ consulta, form, onApply }) {
  const { data } = consulta;
  const propostas = buildCepFillProposals(data, form);
  const [marcados, setMarcados] = useState(() =>
    Object.fromEntries(propostas.map((p) => [p.field, p.selected]))
  );
  const aplicaveis = propostas.filter((p) => p.kind !== "same");
  const comEscolha = propostas.map((p) => ({ ...p, selected: !!marcados[p.field] }));
  const algumMarcado = comEscolha.some((p) => p.selected && p.kind !== "same");

  const aplicar = () => {
    onApply(applyFillProposals(comEscolha));
    consulta.marcarAplicado();
  };

  return (
    <div className="space-y-3 rounded-card border border-slate-200 bg-slate-50 px-4 py-3.5 text-sm dark:border-slate-700 dark:bg-slate-800/60">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold text-slate-900 dark:text-slate-100">Endereço do CEP {formatCEP(consulta.cep)}</p>
        <button type="button" onClick={consulta.descartar} aria-label="Fechar resultado da consulta de CEP"
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
          <X className="h-4 w-4" />
        </button>
      </div>

      <dl className="space-y-1">
        <Linha rotulo="Rua" valor={data.rua} />
        <Linha rotulo="Bairro" valor={data.bairro} />
        <Linha rotulo="Cidade / UF" valor={[data.cidade, data.uf].filter(Boolean).join(" / ")} />
      </dl>

      {consulta.status === "applied" ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle className="h-3.5 w-3.5" /> Cidade e estado preenchidos. Você pode editar à vontade.
        </p>
      ) : aplicaveis.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">Cidade e estado já batem com este CEP.</p>
      ) : (
        <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400">Escolha o que preencher. Campos que já estão preenchidos só mudam se você marcar.</p>
          {aplicaveis.map((p) => (
            <label key={p.field} className="flex cursor-pointer items-start gap-2 text-slate-700 dark:text-slate-200">
              <Checkbox
                checked={!!marcados[p.field]}
                onCheckedChange={(v) => setMarcados((m) => ({ ...m, [p.field]: v === true }))}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{p.label}:</span>{" "}
                {p.kind === "fill" ? p.value : <>substituir “{p.current}” por “{p.value}”</>}
              </span>
            </label>
          ))}
          <Button type="button" size="sm" onClick={aplicar} disabled={!algumMarcado}
            className="rounded-card bg-orange-500 text-white hover:bg-orange-600">
            Preencher campos marcados
          </Button>
        </div>
      )}

      <p className="text-xs text-slate-400 dark:text-slate-500">
        Dados do ViaCEP. Rua e bairro não são salvos; só o CEP, a cidade e o estado.
      </p>
    </div>
  );
}

export function CepLookupResult({ consulta, form, onApply }) {
  if (consulta.status === "error") {
    const code = consulta.error?.code;
    const invalido = code === "invalid";
    // Falha do serviço: sem botão de consulta, o "Tentar de novo" é o único
    // caminho. "Não encontrado" não ganha o link -- daria o mesmo resultado.
    const podeTentarDeNovo = code === "unavailable" || code === "timeout" || code === "rate_limited";
    return (
      <div role="alert" className={`flex items-start gap-1.5 rounded-card border px-3 py-2 text-sm ${
        invalido
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-400"
          : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
      }`}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {consulta.error?.message}
          {podeTentarDeNovo && (
            <>
              {" "}
              <button type="button" onClick={consulta.lookup}
                className="font-semibold text-orange-600 hover:underline dark:text-orange-400">
                Tentar de novo
              </button>
            </>
          )}
        </p>
      </div>
    );
  }
  if ((consulta.status === "success" || consulta.status === "applied") && consulta.data) {
    return <Resultado key={consulta.cep} consulta={consulta} form={form} onApply={onApply} />;
  }
  return null;
}
