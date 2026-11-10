// URL com que o app ABRIU, lida antes de o supabase-js limpar o hash.
//
// Importado como PRIMEIRA linha de main.jsx: o supabase-js lê o
// #access_token do link de confirmação, grava a sessão e apaga o hash
// depois de um await -- quando ConfirmarEmail.jsx monta, o hash já sumiu.
// Erros (#error_code=otp_expired) ficam na URL, mas o caminho é o mesmo.

import { parseAuthRedirect } from "@/lib/signup";

// `path`: a página em que o app abriu -- o resultado só vale para ela
// (navegar depois até /ConfirmarEmail não reaproveita o link de outra hora).
export const AUTH_REDIRECT_AT_LOAD = typeof window === "undefined"
  ? { status: "none", path: "" }
  : { ...parseAuthRedirect(window.location.href), path: window.location.pathname };
