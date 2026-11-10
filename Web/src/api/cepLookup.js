// Consulta de CEP no ViaCEP (GET https://viacep.com.br/ws/{cep}/json/).
//
// Mesmo desenho da consulta de CNPJ (src/api/cnpjLookup.js, seção 202):
// chamada direto do navegador (ViaCEP é público, sem chave, libera CORS),
// cache, consultas simultâneas viram uma, timeout, e nenhuma falha do
// serviço apaga ou "invalida" o que a pessoa digitou.
//
// O QUE ESTA CONSULTA NÃO É: prova de que a empresa existe ou está naquele
// endereço. Só ajuda a preencher cidade e UF.
//
// Rua e bairro voltam só para EXIBIR no painel: não há coluna para eles e
// endereço completo não é publicado em lugar nenhum (seção 205).

import { isValidCEP, normalizeCEP } from "@/lib/cep";
import { buildFillProposals } from "@/api/cnpjLookup";

const BASE_URL = "https://viacep.com.br/ws/";
const TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export const CEP_LOOKUP_MESSAGES = {
  invalid: "CEP inválido. Digite os 8 números.",
  not_found: "CEP não encontrado. Confira o número ou preencha cidade e estado manualmente.",
  rate_limited: "Muitas consultas em pouco tempo. Aguarde um pouco ou preencha manualmente.",
  unavailable: "O serviço de CEP está indisponível agora. Você pode preencher cidade e estado manualmente.",
  timeout: "A consulta de CEP demorou demais e foi cancelada. Tente de novo ou preencha manualmente.",
};

export class CepLookupError extends Error {
  constructor(code) {
    super(CEP_LOOKUP_MESSAGES[code] || CEP_LOOKUP_MESSAGES.unavailable);
    this.name = "CepLookupError";
    this.code = code;
  }
}

function texto(v) {
  return typeof v === "string" ? v.trim() : "";
}

// Resposta do ViaCEP -> objeto do NEXAR. `erro: true` (ou "true", que
// algumas versões mandam) = não encontrado -> null.
export function normalizeViaCep(raw) {
  if (!raw || raw.erro === true || raw.erro === "true") return null;
  return {
    cep: normalizeCEP(raw.cep),
    rua: texto(raw.logradouro),
    bairro: texto(raw.bairro),
    cidade: texto(raw.localidade),
    uf: texto(raw.uf).toUpperCase(),
  };
}

const cache = new Map(); // cep -> { at, value } (value null = não encontrado)
const emAndamento = new Map(); // cep -> Promise

export function _resetCepLookupState() {
  cache.clear();
  emAndamento.clear();
}

async function consultar(cep, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${BASE_URL}${cep}/json/`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new CepLookupError("timeout");
    throw new CepLookupError("unavailable");
  } finally {
    clearTimeout(timer);
  }

  // 400 = formato que o ViaCEP não aceita. Não chega aqui com CEP validado
  // localmente; se chegar, é tratado como "não encontrado", nunca como erro
  // do que a pessoa digitou.
  if (res.status === 400 || res.status === 404) return null;
  if (res.status === 429) throw new CepLookupError("rate_limited");
  if (!res.ok) throw new CepLookupError("unavailable");

  let body;
  try {
    body = await res.json();
  } catch {
    throw new CepLookupError("unavailable");
  }
  return normalizeViaCep(body);
}

export async function lookupCEP(value, { fetchImpl = globalThis.fetch } = {}) {
  if (!isValidCEP(value)) throw new CepLookupError("invalid");
  const cep = normalizeCEP(value);

  const guardado = cache.get(cep);
  if (guardado && Date.now() - guardado.at < CACHE_TTL_MS) {
    if (!guardado.value) throw new CepLookupError("not_found");
    return guardado.value;
  }

  let promessa = emAndamento.get(cep);
  if (!promessa) {
    promessa = consultar(cep, fetchImpl)
      .then((value) => {
        cache.set(cep, { at: Date.now(), value });
        return value;
      })
      .finally(() => emAndamento.delete(cep));
    emAndamento.set(cep, promessa);
  }

  const endereco = await promessa;
  if (!endereco) throw new CepLookupError("not_found");
  return endereco;
}

// Só cidade e UF viram campo. A regra de "não sobrescrever em silêncio" é a
// mesma da consulta de CNPJ (buildFillProposals): campo vazio vem marcado,
// campo com outro valor -- digitado ou vindo do CNPJ -- vem DESMARCADO.
const CAMPOS_CEP = [
  { field: "city", label: "Cidade", from: "cidade" },
  { field: "state", label: "Estado", from: "uf" },
];

export function buildCepFillProposals(endereco, form) {
  return buildFillProposals(endereco, form, CAMPOS_CEP);
}

// Resultado de consulta só vale para o CEP consultado.
export const CEP_LOOKUP_IDLE = { status: "idle", cep: "", data: null, error: null };
export function cepLookupStateFor(state, cepDoCampo) {
  return state && state.cep && state.cep === normalizeCEP(cepDoCampo) ? state : CEP_LOOKUP_IDLE;
}
