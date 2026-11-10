// CEP: normalização, máscara e validação de formato.
//
// CEP é sempre string de 8 dígitos ("01001000"): como número, perderia o
// zero à esquerda de todo CEP de São Paulo. No banco fica só com dígitos
// (user_profiles.cep, supabase/user-profile-cep.sql); a máscara 00000-000 é
// só de tela. A consulta ao ViaCEP fica em src/api/cepLookup.js.

export function normalizeCEP(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 8);
}

// Máscara enquanto a pessoa digita. Letras e símbolos são descartados.
export function formatCEP(value) {
  const d = normalizeCEP(value);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// Exatamente 8 dígitos, aceitando só a máscara oficial ("01001-000") ou
// nada ("01001000"). "0100A000" ou "01001-00" não passam.
export function isValidCEP(value) {
  const s = String(value || "").trim();
  return /^\d{5}-?\d{3}$/.test(s);
}

// Valor para gravar: 8 dígitos, ou null quando vazio. CEP não é
// obrigatório (seção 205).
export function cepForStorage(value) {
  const d = normalizeCEP(value);
  return d.length === 8 ? d : null;
}

// Enquanto supabase/user-profile-cep.sql não rodar, a coluna não existe e
// o PostgREST recusa o write inteiro (PGRST204/42703). Em vez de derrubar o
// cadastro ou o "Salvar" da conta, grava sem o CEP e avisa no console.
export function isMissingCepColumn(error) {
  const code = error?.code;
  return (code === "PGRST204" || code === "42703") && /\bcep\b/i.test(error?.message || "");
}

export async function saveWithOptionalCep(save, data) {
  try {
    return await save(data);
  } catch (error) {
    if (!("cep" in data) || !isMissingCepColumn(error)) throw error;
    console.warn("user_profiles.cep ainda não existe (rode supabase/user-profile-cep.sql). Salvo sem o CEP.");
    const { cep: _cep, ...semCep } = data;
    return save(semCep);
  }
}
