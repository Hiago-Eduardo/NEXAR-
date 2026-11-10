// Regra ÚNICA de senha nova do NEXAR (seção 176). Cadastro, recuperação
// (Login ?recuperar=1) e troca em Configurações usam esta mesma função --
// antes cada tela tinha o seu "length < 6".
//
// Vale só para senha NOVA: quem já tem senha de 6 caracteres continua
// entrando normalmente. O Supabase aceita a partir de 6; esta regra é mais
// exigente do lado do cliente.

export const MIN_PASSWORD_LENGTH = 8;

/** Cada requisito, na ordem em que aparece na tela. */
export function passwordChecks(senha = "") {
  return [
    { key: "length", label: `Pelo menos ${MIN_PASSWORD_LENGTH} caracteres`, ok: senha.length >= MIN_PASSWORD_LENGTH },
    { key: "letter", label: "Pelo menos uma letra", ok: /\p{L}/u.test(senha) },
    { key: "number", label: "Pelo menos um número", ok: /\d/.test(senha) },
  ];
}

export function isStrongPassword(senha) {
  return passwordChecks(senha).every((c) => c.ok);
}

/** Mensagem do primeiro requisito que falta, ou "" se a senha serve. */
export function passwordError(senha) {
  const falta = passwordChecks(senha).find((c) => !c.ok);
  if (!falta) return "";
  return {
    length: `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    letter: "A senha deve ter pelo menos uma letra.",
    number: "A senha deve ter pelo menos um número.",
  }[falta.key];
}
