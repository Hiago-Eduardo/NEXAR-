// CNPJ: normalização, máscara e dígitos verificadores.
//
// O cadastro só formatava ("00.000.000/0000-00") e aceitava qualquer
// sequência de 14 dígitos -- um erro de digitação passava e ficava no perfil
// da empresa (seção 161). Não consulta a Receita: confirma só que o número é
// bem formado, que é o que pega erro de digitação. A consulta cadastral fica
// em src/api/cnpjLookup.js.
//
// CNPJ ALFANUMÉRICO (Receita Federal, a partir de julho de 2026): as 12
// primeiras posições aceitam 0-9 e A-Z; as 2 últimas (DV) continuam
// numéricas. O cálculo é o mesmo módulo 11 de sempre, com cada caractere
// valendo (código ASCII - 48): "0".."9" = 0..9, "A" = 17, "B" = 18 ... "Z" = 42.
// Para um CNPJ só de dígitos o resultado é idêntico ao cálculo antigo.
// Exemplo oficial: 12.ABC.345/01DE-35. O mesmo cálculo existe no banco em
// public.cnpj_is_valid (supabase/cnpj-validation.sql) -- mudou aqui, muda lá.
//
// CNPJ é sempre string: com letras não cabe em número, e mesmo o numérico
// perderia os zeros à esquerda.

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

// Tira a máscara (e qualquer outro separador) e põe as letras em maiúscula.
// "12.abc.345/01de-35" -> "12ABC34501DE35".
export function normalizeCNPJ(value) {
  return String(value || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// Máscara para o campo, enquanto a pessoa digita: aceita letras nas 12
// primeiras posições e só dígitos no DV.
export function formatCNPJ(value) {
  const n = normalizeCNPJ(value);
  const base = n.slice(0, 12);
  const dv = n.slice(12).replace(/\D/g, "").slice(0, 2);
  const c = base + dv;
  let out = c.slice(0, 2);
  if (c.length > 2) out += `.${c.slice(2, 5)}`;
  if (c.length > 5) out += `.${c.slice(5, 8)}`;
  if (c.length > 8) out += `/${c.slice(8, 12)}`;
  if (c.length > 12) out += `-${c.slice(12, 14)}`;
  return out;
}

function digitoVerificador(base) {
  const pesos = base.length === 12 ? PESOS_DV1 : PESOS_DV2;
  const soma = base.split("").reduce((acc, ch, i) => acc + (ch.charCodeAt(0) - 48) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

export function isValidCNPJ(value) {
  const c = normalizeCNPJ(value);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;
  // 00000000000000, 11111111111111... passam na conta, mas não existem.
  if (/^(.)\1{13}$/.test(c)) return false;
  const primeiro = digitoVerificador(c.slice(0, 12));
  const segundo = digitoVerificador(c.slice(0, 12) + primeiro);
  return c.endsWith(`${primeiro}${segundo}`);
}

// Tem letra? A BrasilAPI pode ainda não consultar esse formato -- a tela usa
// isto só para explicar a recusa, nunca para recusar o CNPJ.
export function isAlphanumericCNPJ(value) {
  return /[A-Z]/.test(normalizeCNPJ(value));
}
