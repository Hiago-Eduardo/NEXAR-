// Consulta cadastral de CNPJ na BrasilAPI (GET /api/cnpj/v1/{cnpj}).
//
// Chamada DIRETO do navegador, sem Edge Function: a BrasilAPI é pública, sem
// chave, e libera CORS. Não há segredo a proteger nem custo nosso por
// chamada; o limite de uso é o da própria BrasilAPI, por IP de quem consulta.
// Por isso a consulta funciona também no cadastro, antes do login -- o
// visitante consulta dados públicos da Receita a partir do próprio IP, e
// nada é gravado até ele finalizar o cadastro.
//
// O QUE ESTA CONSULTA NÃO É: prova de que quem preenche é dono da empresa.
// Ela só ajuda a preencher o formulário. Não liga o selo Verificado, não
// mexe em suppliers.verified, plano ou benefício (ver Resumo.md, seção 202).
//
// Só os campos que a tela usa saem daqui -- sócios (qsa), endereço completo,
// telefone e e-mail da Receita são descartados na normalização.

import { isValidCNPJ, normalizeCNPJ } from "@/lib/cnpj";

const BASE_URL = "https://brasilapi.com.br/api/cnpj/v1/";
const TIMEOUT_MS = 10000;
// Resposta boa ou "não encontrado" vale por 10 min: consultar o mesmo CNPJ
// de novo (voltar ao campo, reabrir a edição) não sai para a rede.
const CACHE_TTL_MS = 10 * 60 * 1000;
// Depois de um 429, nenhuma consulta por 30 s: insistir só prolonga o bloqueio.
const RATE_LIMIT_PAUSE_MS = 30 * 1000;

export const CNPJ_LOOKUP_MESSAGES = {
  invalid: "CNPJ inválido. Confira os números antes de consultar.",
  not_found: "CNPJ não localizado na base consultada. Confira o número ou preencha os dados manualmente.",
  bad_request: "A consulta não aceitou este CNPJ. Isso não quer dizer que ele seja inválido -- preencha os dados manualmente.",
  rate_limited: "Muitas consultas em pouco tempo. Aguarde alguns segundos e tente de novo, ou preencha manualmente.",
  unavailable: "O serviço de consulta está indisponível agora. Você pode preencher os dados manualmente.",
  timeout: "A consulta demorou demais e foi cancelada. Tente de novo ou preencha manualmente.",
};

export class CnpjLookupError extends Error {
  constructor(code) {
    super(CNPJ_LOOKUP_MESSAGES[code] || CNPJ_LOOKUP_MESSAGES.unavailable);
    this.name = "CnpjLookupError";
    this.code = code;
  }
}

function textoOuVazio(v) {
  return typeof v === "string" ? v.trim() : "";
}

// "SAO JOSE DOS CAMPOS" -> "Sao Jose dos Campos". A Receita manda caixa
// alta e sem acento; o acento a pessoa corrige se quiser.
const MINUSCULAS = new Set(["de", "da", "do", "das", "dos", "e"]);
export function titleCaseCity(value) {
  return textoOuVazio(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && MINUSCULAS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// Resposta da BrasilAPI -> objeto do NEXAR. Só o necessário.
export function normalizeBrasilApiCompany(raw) {
  const r = raw || {};
  const situacao = textoOuVazio(r.descricao_situacao_cadastral);
  return {
    cnpj: normalizeCNPJ(r.cnpj),
    razaoSocial: textoOuVazio(r.razao_social),
    nomeFantasia: textoOuVazio(r.nome_fantasia),
    cidade: titleCaseCity(r.municipio),
    uf: textoOuVazio(r.uf).toUpperCase(),
    situacao,
    ativa: situacao.toUpperCase() === "ATIVA",
    atividade: textoOuVazio(r.cnae_fiscal_descricao),
  };
}

// Estado do módulo: cache, consultas em andamento e pausa pós-429.
const cache = new Map(); // cnpj -> { at, value } (value null = não encontrado)
const emAndamento = new Map(); // cnpj -> Promise
let pausadoAte = 0;

export function _resetCnpjLookupState() {
  cache.clear();
  emAndamento.clear();
  pausadoAte = 0;
}

async function consultar(cnpj, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${BASE_URL}${cnpj}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new CnpjLookupError("timeout");
    throw new CnpjLookupError("unavailable");
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) return null;
  if (res.status === 400) throw new CnpjLookupError("bad_request");
  if (res.status === 429) {
    pausadoAte = Date.now() + RATE_LIMIT_PAUSE_MS;
    throw new CnpjLookupError("rate_limited");
  }
  if (!res.ok) throw new CnpjLookupError("unavailable");

  let body;
  try {
    body = await res.json();
  } catch {
    throw new CnpjLookupError("unavailable");
  }
  return normalizeBrasilApiCompany(body);
}

// Devolve os dados normalizados, ou lança CnpjLookupError. "Não encontrado"
// também é erro (code "not_found"), mas fica no cache como resposta válida.
// Nenhum erro aqui significa "CNPJ inválido" -- só `invalid`, que é a
// validação local e nunca chega à rede.
export async function lookupCNPJ(value, { fetchImpl = globalThis.fetch } = {}) {
  if (!isValidCNPJ(value)) throw new CnpjLookupError("invalid");
  const cnpj = normalizeCNPJ(value);

  const guardado = cache.get(cnpj);
  if (guardado && Date.now() - guardado.at < CACHE_TTL_MS) {
    if (!guardado.value) throw new CnpjLookupError("not_found");
    return guardado.value;
  }
  if (Date.now() < pausadoAte) throw new CnpjLookupError("rate_limited");

  let promessa = emAndamento.get(cnpj);
  if (!promessa) {
    promessa = consultar(cnpj, fetchImpl)
      .then((value) => {
        cache.set(cnpj, { at: Date.now(), value });
        return value;
      })
      .finally(() => emAndamento.delete(cnpj));
    emAndamento.set(cnpj, promessa);
  }

  const empresa = await promessa;
  if (!empresa) throw new CnpjLookupError("not_found");
  return empresa;
}

// Campos do formulário que a consulta pode preencher. Nome fantasia e CNAE
// são só exibidos: user_profiles não tem coluna de nome fantasia, e o CNAE
// não vira categoria do NEXAR automaticamente.
const CAMPOS = [
  { field: "company_name", label: "Razão social", from: "razaoSocial" },
  { field: "city", label: "Cidade", from: "cidade" },
  { field: "state", label: "Estado", from: "uf" },
];

function iguais(a, b) {
  const n = (v) => String(v || "").trim().toLowerCase();
  return n(a) === n(b);
}

// O que a consulta propõe para cada campo, comparando com o formulário:
//  - "fill"    campo vazio: marcado por padrão;
//  - "replace" campo já tem outro valor: DESMARCADO por padrão (nunca
//              sobrescrever em silêncio);
//  - "same"    já está igual: nada a fazer.
// Campos que a consulta não trouxe ficam de fora. `campos` deixa a consulta
// de CEP (src/api/cepLookup.js) usar a mesma regra com os campos dela.
export function buildFillProposals(company, form, campos = CAMPOS) {
  return campos
    .map(({ field, label, from }) => {
      const novo = company?.[from] || "";
      const atual = String(form?.[field] || "").trim();
      if (!novo) return null;
      const kind = !atual ? "fill" : iguais(atual, novo) ? "same" : "replace";
      return { field, label, current: atual, value: novo, kind, selected: kind === "fill" };
    })
    .filter(Boolean);
}

// Só os campos marcados, prontos para um setForm({ ...form, ...patch }).
export function applyFillProposals(proposals) {
  return Object.fromEntries(
    proposals.filter((p) => p.selected && p.kind !== "same").map((p) => [p.field, p.value])
  );
}

// Resultado de consulta só vale para o CNPJ consultado: mudou o campo, o
// estado volta a ocioso (o resultado anterior some da tela). Comparação pelo
// CNPJ normalizado, então mudar só a máscara não invalida.
export const LOOKUP_IDLE = { status: "idle", cnpj: "", data: null, error: null };
export function lookupStateFor(state, cnpjDoCampo) {
  return state && state.cnpj && state.cnpj === normalizeCNPJ(cnpjDoCampo) ? state : LOOKUP_IDLE;
}
