// Mensagens de erro do Supabase Auth em português.
//
// O supabase-js devolve as mensagens em inglês ("Invalid login credentials",
// "User already registered"...), e Login.jsx/Register.jsx as mostravam cruas
// (seção 161). Primeiro pelo `code` (estável entre versões), depois pelo texto,
// para versões que não mandam código.
const POR_CODIGO = {
  invalid_credentials: "E-mail ou senha incorretos.",
  email_not_confirmed: "Confirme seu e-mail antes de entrar. Procure o link na sua caixa de entrada.",
  user_already_exists: "Já existe uma conta com este e-mail. Entre com ela ou recupere a senha.",
  email_exists: "Já existe uma conta com este e-mail. Entre com ela ou recupere a senha.",
  weak_password: "Senha fraca. Use pelo menos 8 caracteres, com letras e números.",
  same_password: "A nova senha precisa ser diferente da atual.",
  email_address_invalid: "Este e-mail não é válido.",
  over_email_send_rate_limit: "Muitos e-mails enviados em pouco tempo. Aguarde alguns minutos e tente de novo.",
  over_request_rate_limit: "Muitas tentativas em pouco tempo. Aguarde alguns minutos e tente de novo.",
  signup_disabled: "Novos cadastros estão desativados no momento.",
  // Turnstile (§228): token ausente, inválido, vencido ou já usado. Quem
  // chama já reiniciou o desafio (useCaptcha().consume()).
  captcha_failed: "A verificação de segurança falhou ou expirou. Conclua a verificação de novo e tente outra vez.",
};

const POR_TEXTO = [
  [/invalid login credentials/i, POR_CODIGO.invalid_credentials],
  [/email not confirmed/i, POR_CODIGO.email_not_confirmed],
  [/already registered|already been registered/i, POR_CODIGO.user_already_exists],
  [/password should be at least/i, POR_CODIGO.weak_password],
  [/should be different from the old password/i, POR_CODIGO.same_password],
  [/captcha/i, POR_CODIGO.captcha_failed],
  [/rate limit|too many requests/i, POR_CODIGO.over_request_rate_limit],
  [/failed to fetch|network/i, "Sem conexão com o servidor. Verifique sua internet e tente de novo."],
];

export function authErrorMessage(error, fallback = "Algo deu errado. Tente de novo.") {
  if (!error) return fallback;
  if (error.code && POR_CODIGO[error.code]) return POR_CODIGO[error.code];
  const msg = error.message || "";
  const achado = POR_TEXTO.find(([re]) => re.test(msg));
  if (achado) return achado[1];
  return msg || fallback;
}

/**
 * Destino seguro do `?from=` depois do login/cadastro. Só aceita caminho
 * interno ("/Dashboard", "/AdEditor?id=..."), nunca outro domínio: "//site.com"
 * e "https://site.com" seriam um redirecionamento aberto para phishing.
 * URL completa da própria origem vira caminho (o App.jsx manda o href inteiro).
 */
export function safeReturnPath(from, origin) {
  if (!from) return null;
  // O navegador apaga tab/quebra de linha da URL: "/\t/site.com" viraria "//site.com".
  if (/[\u0000-\u001f\u007f]/.test(from)) return null;
  let caminho = from;
  if (origin && caminho.startsWith(origin)) caminho = caminho.slice(origin.length) || "/";
  if (!caminho.startsWith("/") || caminho.startsWith("//") || caminho.startsWith("/\\")) return null;
  // Voltar para o próprio login/cadastro não é destino.
  if (/^\/(Login|Register)(\?|$|\/)/i.test(caminho)) return null;
  return caminho;
}
