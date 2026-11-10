import React, { useState } from "react";
import { KeyRound, Loader2, CheckCircle2 } from "lucide-react";
import { supabase } from "@/api/client";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { PasswordInput, PasswordRequirements } from "@/components/shared/PasswordInput";
import { isStrongPassword, passwordError } from "@/lib/password";
import { authErrorMessage } from "@/lib/authErrors";
import { isCaptchaError } from "@/lib/turnstile";
import { useCaptcha } from "@/components/shared/Turnstile";

const ERRO_CAMPO = "mt-1.5 text-xs text-red-600 dark:text-red-400";

/**
 * Troca de senha em Configurações (seção 176), no padrão das contas grandes:
 * fechada por padrão, abre no lugar; uma coluna; olho em cada campo;
 * requisitos marcados enquanto digita; erro embaixo do campo certo (não em
 * toast); "Esqueceu a senha?"; e encerrar as sessões dos outros aparelhos.
 */
export default function ChangePasswordSection({ user }) {
  const [aberto, setAberto] = useState(false);
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [sairDosOutros, setSairDosOutros] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erroAtual, setErroAtual] = useState("");
  const [erroGeral, setErroGeral] = useState("");
  const [sucesso, setSucesso] = useState("");
  const [recuperacao, setRecuperacao] = useState(""); // "", "enviando", "enviado", "erro"
  // Conferir a senha atual é um signInWithPassword, e "Esqueceu a senha?" um
  // resetPasswordForEmail: com o CAPTCHA ligado no Supabase, os dois exigem
  // token (§228). O widget só aparece com o formulário aberto.
  const captcha = useCaptcha({ action: "change_password" });

  const diferenteDaAtual = nova.length > 0 && nova !== atual;
  const confere = confirmacao.length > 0 && nova === confirmacao;
  const podeSalvar = atual && isStrongPassword(nova) && diferenteDaAtual && confere && !salvando && captcha.canSubmit;

  const fechar = () => {
    setAberto(false);
    setAtual("");
    setNova("");
    setConfirmacao("");
    setErroAtual("");
    setErroGeral("");
    setRecuperacao("");
  };

  async function enviarRecuperacao() {
    if (!captcha.canSubmit) {
      setErroGeral("Conclua a verificação de segurança antes de pedir o link.");
      return;
    }
    setRecuperacao("enviando");
    const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
      redirectTo: `${window.location.origin}${createPageUrl("Login")}?recuperar=1`,
      captchaToken: captcha.consume(),
    });
    setRecuperacao(error ? "erro" : "enviado");
    if (error && isCaptchaError(error)) setErroGeral(authErrorMessage(error));
  }

  async function salvar(e) {
    e.preventDefault();
    setErroAtual("");
    setErroGeral("");
    // O botão já fica desabilitado; isto cobre o Enter.
    const problema = passwordError(nova) || (!diferenteDaAtual && "A nova senha precisa ser diferente da atual.")
      || (!confere && "As senhas não conferem.");
    if (problema) {
      setErroGeral(problema);
      return;
    }

    setSalvando(true);
    try {
      // Confere a senha ATUAL antes de trocar (seção 169): sem isso, quem
      // pegasse a sessão aberta tomava a conta.
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: atual,
        options: { captchaToken: captcha.consume() },
      });
      if (authError) {
        // Só credencial errada é "senha incorreta": CAPTCHA recusado, limite
        // ou rede têm a mensagem própria (antes, qualquer erro virava isto).
        if (authError.code === "invalid_credentials" || /invalid login credentials/i.test(authError.message || "")) {
          setErroAtual("Senha atual incorreta.");
        } else {
          setErroGeral(authErrorMessage(authError, "Não foi possível conferir sua senha atual. Tente de novo."));
        }
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: nova });
      if (error) throw error;

      let saiu = false;
      if (sairDosOutros) {
        // Só as OUTRAS sessões: esta continua aberta.
        const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
        saiu = !signOutError;
      }
      fechar();
      setSucesso(
        saiu
          ? "Senha alterada. As sessões nos outros dispositivos foram encerradas."
          : "Senha alterada."
      );
    } catch (error) {
      setErroGeral(authErrorMessage(error, "Não foi possível alterar sua senha. Tente de novo."));
    } finally {
      setSalvando(false);
    }
  }

  if (!aberto) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-card bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center shrink-0">
              <KeyRound className="w-4 h-4 text-orange-500" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-100">Senha</p>
              <p className="text-xs tracking-widest text-slate-400 dark:text-slate-500" aria-hidden="true">••••••••</p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => { setSucesso(""); setAberto(true); }}
            className="rounded-card"
          >
            Alterar senha
          </Button>
        </div>
        {sucesso && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> {sucesso}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={salvar} className="space-y-4" noValidate>
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-orange-500" />
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Alterar senha</p>
      </div>

      <div className="max-w-md space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="current-password" className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Senha atual
            </Label>
            <button
              type="button"
              onClick={enviarRecuperacao}
              disabled={recuperacao === "enviando" || recuperacao === "enviado" || !captcha.canSubmit}
              className="text-xs font-medium text-orange-600 hover:underline disabled:no-underline disabled:opacity-60 dark:text-orange-400"
            >
              Esqueceu a senha?
            </button>
          </div>
          <PasswordInput
            id="current-password"
            autoComplete="current-password"
            value={atual}
            onChange={(e) => { setAtual(e.target.value); setErroAtual(""); }}
            aria-invalid={!!erroAtual}
            aria-describedby={erroAtual ? "current-password-error" : undefined}
            className="mt-1.5 h-10 rounded-card"
          />
          {erroAtual && <p id="current-password-error" role="alert" className={ERRO_CAMPO}>{erroAtual}</p>}
          {recuperacao === "enviado" && (
            <p role="status" className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Enviamos um link para redefinir a senha para {user.email}.
            </p>
          )}
          {recuperacao === "erro" && (
            <p role="alert" className={ERRO_CAMPO}>Não foi possível enviar o e-mail agora. Tente de novo.</p>
          )}
        </div>

        <div>
          <Label htmlFor="new-password" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Nova senha
          </Label>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            value={nova}
            onChange={(e) => setNova(e.target.value)}
            aria-describedby="new-password-rules"
            className="mt-1.5 h-10 rounded-card"
          />
          <PasswordRequirements
            id="new-password-rules"
            senha={nova}
            extras={[{ key: "diferente", label: "Diferente da senha atual", ok: diferenteDaAtual }]}
          />
        </div>

        <div>
          <Label htmlFor="confirm-password" className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Confirmar nova senha
          </Label>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            value={confirmacao}
            onChange={(e) => setConfirmacao(e.target.value)}
            aria-invalid={confirmacao.length > 0 && !confere}
            className="mt-1.5 h-10 rounded-card"
          />
          {confirmacao.length > 0 && !confere && (
            <p className={ERRO_CAMPO}>As senhas não conferem.</p>
          )}
        </div>

        <label htmlFor="sign-out-others" className="flex items-start gap-2.5 cursor-pointer">
          <Checkbox
            id="sign-out-others"
            checked={sairDosOutros}
            onCheckedChange={(v) => setSairDosOutros(v === true)}
            className="mt-0.5"
          />
          <span className="text-sm text-slate-700 dark:text-slate-300">
            Encerrar a sessão nos outros dispositivos
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Recomendado se você acha que alguém mais tem acesso à sua conta.
            </span>
          </span>
        </label>

        {captcha.widget}

        {erroGeral && (
          <p role="alert" className="rounded-card border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {erroGeral}
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="submit" disabled={!podeSalvar} className="rounded-card bg-orange-500 hover:bg-orange-600 text-white gap-1.5">
            {salvando && <Loader2 className="w-4 h-4 animate-spin" />}
            Salvar nova senha
          </Button>
          <Button type="button" variant="ghost" onClick={fechar} disabled={salvando} className="rounded-card">
            Cancelar
          </Button>
        </div>
      </div>
    </form>
  );
}
