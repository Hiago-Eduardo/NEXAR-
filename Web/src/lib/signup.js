// Cadastro com confirmação de e-mail (seção 208).
//
// Com "Confirm email" ligado no Supabase, o signUp volta sem sessão: quem
// cria o perfil é o trigger nexar_create_profile_on_signup
// (supabase/signup-profile-trigger.sql), a partir de
// options.data.nexar_profile. Quem decide se a conta pode entrar é o próprio
// Supabase Auth (sem e-mail confirmado não há sessão, e sem sessão a RLS
// não deixa ver nada) -- aqui não existe verificação paralela.

export const CONFIRM_PAGE_PATH = "/ConfirmarEmail";

// Espera entre reenvios. O Supabase também limita (over_email_send_rate_limit,
// "you can only request this after N seconds"); este é o mínimo da tela.
export const RESEND_COOLDOWN_SECONDS = 60;

// Para onde o link do e-mail volta. Precisa estar em Authentication -> URL
// Configuration -> Redirect URLs (http://localhost:5173/** e o domínio de
// produção), senão o Supabase ignora e manda para o Site URL.
export function confirmRedirectUrl(origin, from) {
  const url = new URL(CONFIRM_PAGE_PATH, origin);
  if (from) url.searchParams.set("from", from);
  return url.toString();
}

// O que o link de confirmação trouxe na URL. O supabase-js (fluxo
// implícito) lê o mesmo hash, grava a sessão e APAGA o hash logo depois --
// por isso a URL é capturada na carga do app (src/lib/authRedirect.js).
//   confirmed: #access_token=...&type=signup
//   expired:   error_code=otp_expired (link vencido ou já usado)
//   invalid:   qualquer outro erro
//   none:      a página foi aberta sem vir de um link
export function parseAuthRedirect(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return { status: "none" };
  }
  const params = new URLSearchParams(url.search);
  new URLSearchParams(url.hash.replace(/^#/, "")).forEach((v, k) => params.set(k, v));

  const errorCode = params.get("error_code");
  const error = params.get("error");
  if (errorCode || error || params.get("error_description")) {
    return {
      status: errorCode === "otp_expired" ? "expired" : "invalid",
      code: errorCode || error || "unknown",
      description: params.get("error_description") || "",
    };
  }
  if (params.get("access_token")) {
    return { status: "confirmed", type: params.get("type") || "" };
  }
  return { status: "none" };
}

// Segundos de espera depois de um erro de reenvio: o que o Supabase disser
// ("after 42 seconds"), senão o padrão.
export function resendWaitSeconds(error, fallback = RESEND_COOLDOWN_SECONDS) {
  const m = /after (\d+) seconds?/i.exec(error?.message || "");
  return m ? Number(m[1]) : fallback;
}

export function isResendRateLimit(error) {
  return error?.code === "over_email_send_rate_limit"
    || error?.status === 429
    || /only request this after|rate limit/i.test(error?.message || "");
}

// signUp com o perfil não confirmado: o Supabase não diz se o e-mail já
// existe (proteção contra enumeração) -- devolve um usuário sem
// identidades e não manda e-mail.
export function isExistingAccountSignup(data) {
  return Array.isArray(data?.user?.identities) && data.user.identities.length === 0;
}

// Metadados do signUp. O trigger valida tudo de novo no servidor; aqui só
// não manda o que não é do perfil.
const CAMPOS_PERFIL = ["full_name", "cnpj", "company_name", "phone", "cep", "city", "state", "segment"];

export function buildSignupMetadata(form, userType) {
  const tipo = userType === "fornecedor" ? "fornecedor" : "cliente";
  const nexar_profile = { user_type: tipo };
  for (const campo of CAMPOS_PERFIL) {
    const valor = typeof form?.[campo] === "string" ? form[campo].trim() : "";
    if (valor) nexar_profile[campo] = valor;
  }
  return {
    full_name: (form?.full_name || "").trim(),
    user_type: tipo,
    role: tipo,
    nexar_profile,
  };
}
