import React, { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, Loader2, AlertTriangle, Mail } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { safeReturnPath } from "@/lib/authErrors";
import { AUTH_REDIRECT_AT_LOAD } from "@/lib/authRedirect";
import { CONFIRM_PAGE_PATH } from "@/lib/signup";
import ResendConfirmation from "@/components/shared/ResendConfirmation";

/**
 * Destino do link de confirmação de e-mail (seção 208).
 *
 * Quem confirma é o Supabase: o link passa por /auth/v1/verify, que marca o
 * e-mail como confirmado e volta para cá com a sessão no hash (o supabase-js
 * grava a sessão e limpa a URL) ou com o erro (#error_code=otp_expired...).
 * Esta página só lê o que veio -- capturado na carga do app em
 * src/lib/authRedirect.js, antes de o hash sumir -- e explica.
 */

function Moldura({ icone, titulo, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12 dark:bg-slate-950">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <Card className="rounded-card border border-slate-200 shadow-sm dark:border-slate-800">
          <CardContent className="space-y-5 p-8 text-center">
            {icone}
            <h1 className="font-display text-2xl font-black text-slate-900 dark:text-slate-50">{titulo}</h1>
            {children}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

const ICONE_ALERTA = (
  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-orange-50 dark:bg-orange-500/10">
    <AlertTriangle className="h-8 w-8 text-orange-500" />
  </div>
);

export default function ConfirmarEmail() {
  const [searchParams] = useSearchParams();
  const { user, authChecked } = useAuth();
  const from = safeReturnPath(searchParams.get("from"), window.location.origin);

  const retorno = AUTH_REDIRECT_AT_LOAD.path === CONFIRM_PAGE_PATH ? AUTH_REDIRECT_AT_LOAD : { status: "none" };

  // Erro fica no hash (o supabase-js só limpa quando dá certo): tira da
  // barra de endereço para não ficar "#error=access_denied&..." à vista.
  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);

  const destino = from
    || (user?.role === "fornecedor" ? `${createPageUrl("Planos")}?onboarding=1` : createPageUrl("Suppliers"));
  const textoDestino = from ? "Continuar" : user?.role === "fornecedor" ? "Escolher meu plano" : "Ver fornecedores";

  if (retorno.status === "expired") {
    return (
      <Moldura icone={ICONE_ALERTA} titulo="Link expirado">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Este link de confirmação expirou ou já foi usado. Se você já confirmou, é só entrar.
          Se não, peça um novo link abaixo.
        </p>
        <ResendConfirmation from={from} />
        <Link to={createPageUrl("Login")} className="block text-sm font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400">
          Já confirmei — Entrar
        </Link>
      </Moldura>
    );
  }

  if (retorno.status === "invalid") {
    return (
      <Moldura icone={ICONE_ALERTA} titulo="Link inválido">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Não conseguimos confirmar o e-mail com este link. Ele pode estar incompleto -- abra-o direto do
          e-mail, sem copiar só um pedaço -- ou peça um novo.
        </p>
        <ResendConfirmation from={from} />
        <Link to={createPageUrl("Login")} className="block text-sm font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400">
          Ir para o login
        </Link>
      </Moldura>
    );
  }

  if (retorno.status === "confirmed" && (!authChecked || !user)) {
    // Sessão do link ainda chegando ao AuthContext.
    if (!authChecked) {
      return (
        <Moldura icone={<Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-500" />} titulo="Confirmando seu e-mail…" />
      );
    }
    // O Supabase recusou o token do hash: trata como link inválido.
    return (
      <Moldura icone={ICONE_ALERTA} titulo="Link inválido">
        <p className="text-sm text-slate-500 dark:text-slate-400">Não conseguimos validar este link. Peça um novo abaixo.</p>
        <ResendConfirmation from={from} />
      </Moldura>
    );
  }

  if (retorno.status === "confirmed" || (authChecked && user)) {
    return (
      <Moldura
        icone={(
          // Verde de propósito: confirmação semântica real (seção 71).
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10">
            <CheckCircle className="h-8 w-8 text-emerald-500" />
          </div>
        )}
        titulo={retorno.status === "confirmed" ? "E-mail confirmado!" : "Seu e-mail já está confirmado"}
      >
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Sua conta está ativa e você já entrou nela.
        </p>
        <Link to={destino}>
          <Button className="h-11 w-full rounded-card bg-orange-500 text-white hover:bg-orange-600">{textoDestino}</Button>
        </Link>
      </Moldura>
    );
  }

  if (!authChecked) {
    return <Moldura icone={<Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-500" />} titulo="Carregando…" />;
  }

  // Aberta sem vir de um link, e sem sessão.
  return (
    <Moldura
      icone={(
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-orange-50 dark:bg-orange-500/10">
          <Mail className="h-8 w-8 text-orange-500" />
        </div>
      )}
      titulo="Confirme seu e-mail"
    >
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Abra o link que enviamos para o seu e-mail no cadastro. Não encontrou? Peça outro.
      </p>
      <ResendConfirmation from={from} />
      <Link to={createPageUrl("Login")} className="block text-sm font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400">
        Ir para o login
      </Link>
    </Moldura>
  );
}
