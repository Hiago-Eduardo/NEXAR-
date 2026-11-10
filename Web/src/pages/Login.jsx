import React, { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Mail, Lock, ArrowRight, Sparkles } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { authErrorMessage, safeReturnPath } from "@/lib/authErrors";
import { PasswordInput, PasswordRequirements } from "@/components/shared/PasswordInput";
import { MIN_PASSWORD_LENGTH, passwordError } from "@/lib/password";
import ResendConfirmation from "@/components/shared/ResendConfirmation";
import { useCaptcha } from "@/components/shared/Turnstile";

const ERRO = "rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-400";
const SUCESSO = "rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-500/10 dark:text-emerald-400";
const ROTULO = "text-sm text-slate-600 dark:text-slate-300";
const ICONE = "absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500";

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, authChecked } = useAuth();

  // Para onde voltar depois de entrar: a página protegida que mandou para cá
  // (api.auth.redirectToLogin), filtrada contra redirecionamento aberto.
  const from = safeReturnPath(searchParams.get("from"), window.location.origin);
  // O link do e-mail de recuperação volta com ?recuperar=1 e já com sessão
  // (o supabase-js lê o token da URL). Antes ele voltava para o formulário de
  // LOGIN, e não havia onde definir a nova senha (seção 161).
  const recuperando = searchParams.get("recuperar") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingReset, setSendingReset] = useState(false);
  const [error, setError] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirmation, setNewPasswordConfirmation] = useState("");
  const [passwordChanged, setPasswordChanged] = useState(false);
  // E-mail de uma conta que tentou entrar sem ter confirmado o cadastro.
  const [naoConfirmado, setNaoConfirmado] = useState("");
  // { userId, path }: login feito, esperando o AuthContext enxergar a sessão.
  //
  // Navegar logo depois do signIn era uma CORRIDA: o AuthContext só atualiza
  // `user` quando o evento SIGNED_IN termina de processar, e a página de
  // destino (Dashboard, AdEditor...) via `authChecked && !user` e mandava de
  // volta para o login. O código antigo fazia um getUser() extra antes de
  // navegar, e essa ida ao servidor escondia a corrida por acaso (seção 161).
  const [destinoPendente, setDestinoPendente] = useState(null);
  // Um desafio para "Entrar" e "Esqueci minha senha" (§228). O token é de
  // uso único: consume() o entrega e já reinicia o widget.
  const captcha = useCaptcha({ action: "login" });

  useEffect(() => {
    if (destinoPendente && user?.id === destinoPendente.userId) {
      navigate(destinoPendente.path);
    }
  }, [destinoPendente, user, navigate]);

  const destinoPorPapel = (authUser) => {
    const role = authUser?.user_metadata?.role
      || authUser?.user_metadata?.user_type
      || authUser?.app_metadata?.role
      || "cliente";
    return createPageUrl(role === "fornecedor" ? "Dashboard" : "Suppliers");
  };

  async function handleLogin(e) {
    e.preventDefault();
    if (!captcha.canSubmit) return;
    setLoading(true);
    setError("");
    setResetSent(false);
    setNaoConfirmado("");

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
        options: { captchaToken: captcha.consume() },
      });
      if (signInError) throw signInError;
      // `loading` continua true até a navegação: o botão segue em
      // "Entrando..." enquanto o AuthContext alcança a sessão.
      setDestinoPendente({ userId: data.user.id, path: from || destinoPorPapel(data.user) });
    } catch (err) {
      setError(authErrorMessage(err, "Não foi possível entrar. Verifique os dados e tente novamente."));
      if (err?.code === "email_not_confirmed" || /email not confirmed/i.test(err?.message || "")) {
        setNaoConfirmado(email.trim());
      }
      setLoading(false);
    }
  }

  async function handlePasswordReset() {
    if (!email.trim()) {
      setError("Informe seu e-mail acima para receber o link de recuperação.");
      return;
    }
    if (!captcha.canSubmit) {
      setError("Conclua a verificação de segurança antes de pedir o link.");
      return;
    }

    // Estado próprio: antes usava o mesmo `loading` do login, e o botão
    // "Entrar" mostrava "Entrando..." enquanto o e-mail era enviado.
    setSendingReset(true);
    setError("");

    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}${createPageUrl("Login")}?recuperar=1`,
        captchaToken: captcha.consume(),
      });
      if (resetError) throw resetError;
      setResetSent(true);
    } catch (err) {
      setError(authErrorMessage(err, "Não foi possível enviar o e-mail de recuperação."));
    } finally {
      setSendingReset(false);
    }
  }

  async function handleNewPassword(e) {
    e.preventDefault();
    setError("");
    // Regra única de senha nova (src/lib/password.js, seção 176).
    const senhaFraca = passwordError(newPassword);
    if (senhaFraca) {
      setError(senhaFraca);
      return;
    }
    if (newPassword !== newPasswordConfirmation) {
      setError("As senhas não conferem.");
      return;
    }
    setLoading(true);
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) throw updateError;
      setPasswordChanged(true);
      setTimeout(() => navigate(destinoPorPapel(data.user)), 1500);
    } catch (err) {
      setError(authErrorMessage(err, "Não foi possível definir a nova senha."));
    } finally {
      setLoading(false);
    }
  }

  const cabecalho = recuperando
    ? { titulo: "Nova senha", texto: "Escolha a nova senha da sua conta.", card: "Definir nova senha" }
    : { titulo: "Entrar", texto: "Acesse sua conta para gerenciar seu perfil, mensagens e anúncios.", card: "Bem-vindo de volta" };

  let conteudo;
  if (recuperando && !authChecked) {
    conteudo = (
      <div className="flex justify-center py-6">
        <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
      </div>
    );
  } else if (recuperando && !user) {
    // Sem sessão: o link já foi usado, expirou, ou foi aberto em outro
    // navegador. Não há como trocar a senha sem ele.
    conteudo = (
      <div className="space-y-5">
        <div role="alert" className={ERRO}>
          Este link de recuperação expirou ou já foi usado. Peça um novo na tela de login.
        </div>
        <Link to={createPageUrl("Login")}>
          <Button className="w-full h-11 rounded-card bg-orange-500 hover:bg-orange-600 text-white">Voltar ao login</Button>
        </Link>
      </div>
    );
  } else if (recuperando) {
    conteudo = passwordChanged ? (
      <div role="status" className={SUCESSO}>Senha alterada. Entrando na sua conta...</div>
    ) : (
      <form onSubmit={handleNewPassword} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="new-password" className={ROTULO}>Nova senha</Label>
          <PasswordInput id="new-password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required
            leftIcon={<Lock className={ICONE} />}
            value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            aria-describedby="new-password-rules"
            placeholder={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres`} className="pl-10 h-11 rounded-card" />
          <PasswordRequirements id="new-password-rules" senha={newPassword} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password-confirmation" className={ROTULO}>Confirmar nova senha</Label>
          <PasswordInput id="new-password-confirmation" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required
            leftIcon={<Lock className={ICONE} />}
            value={newPasswordConfirmation} onChange={(e) => setNewPasswordConfirmation(e.target.value)}
            placeholder="Repita a nova senha" className="pl-10 h-11 rounded-card" />
        </div>
        {error && <div role="alert" className={ERRO}>{error}</div>}
        <Button type="submit" disabled={loading} className="w-full h-11 rounded-card bg-orange-500 hover:bg-orange-600 text-white">
          {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Salvando...</> : "Salvar nova senha"}
        </Button>
      </form>
    );
  } else {
    conteudo = (
      <>
        <form onSubmit={handleLogin} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email" className={ROTULO}>Email</Label>
            <div className="relative">
              <Mail className={ICONE} />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                className="pl-10 h-11 rounded-card"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className={ROTULO}>Senha</Label>
            <PasswordInput
              id="password"
              leftIcon={<Lock className={ICONE} />}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="pl-10 h-11 rounded-card"
              required
            />
          </div>

          {captcha.widget}

          {error && <div role="alert" className={ERRO}>{error}</div>}

          {/* Conta ainda não confirmada: o Supabase recusa o login
              (email_not_confirmed) -- a regra é dele, aqui só oferecemos
              um link novo (seção 208). */}
          {naoConfirmado && (
            <ResendConfirmation key={naoConfirmado} email={naoConfirmado} from={from} />
          )}

          {resetSent && (
            <div role="status" className={SUCESSO}>
              Se houver uma conta com este e-mail, enviamos um link para definir uma nova senha.
            </div>
          )}

          <div className="text-right">
            <button
              type="button"
              onClick={handlePasswordReset}
              disabled={sendingReset || !captcha.canSubmit}
              className="text-sm font-medium text-orange-600 hover:text-orange-700 disabled:opacity-60 dark:text-orange-400"
            >
              {sendingReset ? "Enviando link..." : "Esqueci minha senha"}
            </button>
          </div>

          <Button
            type="submit"
            className="w-full h-11 rounded-card bg-orange-500 hover:bg-orange-600 text-white"
            disabled={loading || !captcha.canSubmit}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Entrando...
              </>
            ) : (
              <>
                Entrar
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </form>

        <div className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
          Ainda não tem conta?{" "}
          {/* Repassa o ?from=: quem se cadastra a partir daqui volta para a
              página que queria abrir. */}
          <Link
            to={from ? `${createPageUrl("Register")}?from=${encodeURIComponent(from)}` : createPageUrl("Register")}
            className="font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400"
          >
            Criar conta
          </Link>
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-card bg-orange-500 text-white shadow-lg shadow-orange-200 dark:shadow-none">
            <Sparkles className="w-8 h-8" />
          </div>
          <h1 className="mt-5 text-3xl font-bold text-slate-900 dark:text-slate-50">{cabecalho.titulo}</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">{cabecalho.texto}</p>
        </div>

        <Card className="rounded-card border border-slate-200 shadow-sm dark:border-slate-800">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">{cabecalho.card}</CardTitle>
          </CardHeader>
          <CardContent>{conteudo}</CardContent>
        </Card>
      </div>
    </div>
  );
}
