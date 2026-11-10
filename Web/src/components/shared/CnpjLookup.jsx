import React, { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Search, AlertTriangle, CheckCircle, X } from "lucide-react";
import { isValidCNPJ, normalizeCNPJ, formatCNPJ, isAlphanumericCNPJ } from "@/lib/cnpj";
import {
  lookupCNPJ, CnpjLookupError, buildFillProposals, applyFillProposals, lookupStateFor, LOOKUP_IDLE,
} from "@/api/cnpjLookup";

/**
 * Consulta de CNPJ na BrasilAPI para PREENCHER o formulário da empresa
 * (Register e Minha Conta). A consulta não comprova que a pessoa é dona da
 * empresa: não liga selo, não mexe em plano, não grava nada sozinha -- só
 * propõe valores, e quem decide é a pessoa (seção 202).
 *
 * Uso: `const consulta = useCnpjLookup(form.cnpj)`, o botão ao lado do campo
 * e o painel de resultado logo abaixo da linha do campo.
 *
 * `{ auto: true }` (só no cadastro): consulta sozinha quando o CNPJ fica
 * completo e válido, depois de AUTO_DELAY_MS sem mudar -- colar e corrigir
 * um dígito vira uma consulta só. Cada CNPJ é consultado automaticamente
 * UMA vez: fechar o painel ou voltar ao mesmo número não dispara de novo
 * (o botão continua para isso). Só mostra os dados; preencher continua
 * sendo escolha da pessoa.
 */

const AUTO_DELAY_MS = 600;

export function useCnpjLookup(cnpj, { auto = false } = {}) {
  const atual = normalizeCNPJ(cnpj);
  const valid = isValidCNPJ(atual);
  const [state, setState] = useState(LOOKUP_IDLE);
  const autoConsultados = useRef(new Set());

  // Resultado de outro CNPJ não vale para o atual: mudou o campo, o
  // resultado anterior some (sem efeito, só derivação).
  const vigente = lookupStateFor(state, atual);

  const lookup = useCallback(async () => {
    if (!isValidCNPJ(atual)) {
      setState({ status: "error", cnpj: atual, data: null, error: new CnpjLookupError("invalid") });
      return;
    }
    setState({ status: "loading", cnpj: atual, data: null, error: null });
    try {
      const data = await lookupCNPJ(atual);
      setState((s) => (s.cnpj === atual ? { status: "success", cnpj: atual, data, error: null } : s));
    } catch (error) {
      const erro = error instanceof CnpjLookupError ? error : new CnpjLookupError("unavailable");
      setState((s) => (s.cnpj === atual ? { status: "error", cnpj: atual, data: null, error: erro } : s));
    }
  }, [atual]);

  useEffect(() => {
    if (!auto || !valid || autoConsultados.current.has(atual)) return undefined;
    const timer = setTimeout(() => {
      autoConsultados.current.add(atual);
      lookup();
    }, AUTO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [auto, valid, atual, lookup]);

  const marcarAplicado = () => setState((s) => ({ ...s, status: "applied" }));
  const descartar = () => setState(LOOKUP_IDLE);

  return { ...vigente, valid, lookup, marcarAplicado, descartar };
}

export function CnpjLookupButton({ consulta, className = "" }) {
  const carregando = consulta.status === "loading";
  // Já consultado este CNPJ: o resultado está na tela, não há o que buscar.
  const jaConsultado = consulta.status === "success" || consulta.status === "applied";
  return (
    <Button
      type="button"
      variant="outline"
      onClick={consulta.lookup}
      disabled={carregando || jaConsultado || !consulta.valid}
      title={consulta.valid ? undefined : "Digite um CNPJ válido para consultar"}
      className={`h-11 shrink-0 gap-1.5 rounded-card ${className}`}
    >
      {carregando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
      {carregando ? "Consultando…" : consulta.status === "error" ? "Consultar de novo" : "Consultar CNPJ"}
    </Button>
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
  const propostas = buildFillProposals(data, form);
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
        <p className="font-semibold text-slate-900 dark:text-slate-100">
          Dados encontrados para {formatCNPJ(consulta.cnpj)}
        </p>
        <button type="button" onClick={consulta.descartar} aria-label="Fechar resultado da consulta"
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
          <X className="h-4 w-4" />
        </button>
      </div>

      <dl className="space-y-1">
        <Linha rotulo="Razão social" valor={data.razaoSocial} />
        <Linha rotulo="Nome fantasia" valor={data.nomeFantasia} />
        <Linha rotulo="Cidade / UF" valor={[data.cidade, data.uf].filter(Boolean).join(" / ")} />
        <Linha rotulo="Situação" valor={data.situacao} />
        <Linha rotulo="Atividade (CNAE)" valor={data.atividade} />
      </dl>

      {!data.ativa && data.situacao && (
        <p className="flex items-start gap-1.5 text-xs text-orange-800 dark:text-orange-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          A situação cadastral desta empresa na Receita é “{data.situacao}”, não “Ativa”. Confira se é o CNPJ certo.
        </p>
      )}

      {consulta.status === "applied" ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle className="h-3.5 w-3.5" /> Campos preenchidos. Revise antes de salvar.
        </p>
      ) : aplicaveis.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">Seus campos já batem com estes dados.</p>
      ) : (
        <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
          <p className="text-xs text-slate-500 dark:text-slate-400">Escolha o que preencher. Campos que você já preencheu só mudam se você marcar.</p>
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
        Dados públicos da Receita Federal via BrasilAPI. A consulta não confirma que você representa a empresa.
      </p>
    </div>
  );
}

export function CnpjLookupResult({ consulta, form, onApply }) {
  if (consulta.status === "error") {
    const invalido = consulta.error?.code === "invalid";
    const extra = consulta.error?.code === "bad_request" && isAlphanumericCNPJ(consulta.cnpj)
      ? " A consulta pode ainda não aceitar CNPJ com letras."
      : "";
    return (
      <p role="alert" className={`flex items-start gap-1.5 rounded-card border px-3 py-2 text-sm ${
        invalido
          ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-400"
          : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300"
      }`}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        {consulta.error?.message}{extra}
      </p>
    );
  }
  if ((consulta.status === "success" || consulta.status === "applied") && consulta.data) {
    // key: um CNPJ novo começa com as escolhas padrão dele.
    return <Resultado key={consulta.cnpj} consulta={consulta} form={form} onApply={onApply} />;
  }
  return null;
}
