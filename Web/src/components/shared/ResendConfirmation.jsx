import React, { useEffect, useState } from "react";
import { supabase } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail } from "lucide-react";
import { authErrorMessage } from "@/lib/authErrors";
import {
  confirmRedirectUrl, RESEND_COOLDOWN_SECONDS, resendWaitSeconds, isResendRateLimit,
} from "@/lib/signup";
import { useCaptcha } from "@/components/shared/Turnstile";

/**
 * "Reenviar link de confirmação" (seção 208). Usado na tela "Verifique seu
 * e-mail" do cadastro, no login de conta não confirmada e na página de link
 * expirado/inválido.
 *
 * Espera RESEND_COOLDOWN_SECONDS entre envios (contagem no botão); se o
 * Supabase recusar por limite, usa o tempo que ele informar. `email` vazio
 * mostra um campo para a pessoa digitar (link expirado não traz o e-mail).
 * `startCooldown`: o cadastro acabou de enviar um e-mail, então já começa
 * esperando.
 *
 * O reenvio também passa pelo Turnstile (§228): com o CAPTCHA ligado no
 * Supabase, /resend exige token. Desafio próprio, porque o do formulário em
 * volta (login) já foi consumido.
 */
export default function ResendConfirmation({ email: emailInicial = "", from = null, startCooldown = false }) {
  const [email, setEmail] = useState(emailInicial);
  const [espera, setEspera] = useState(startCooldown ? RESEND_COOLDOWN_SECONDS : 0);
  const [enviando, setEnviando] = useState(false);
  const [mensagem, setMensagem] = useState(null); // { tipo: "ok" | "erro", texto }
  const captcha = useCaptcha({ action: "resend" });

  useEffect(() => {
    if (espera <= 0) return undefined;
    const t = setTimeout(() => setEspera((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [espera]);

  const pedirEmail = !emailInicial;

  async function reenviar() {
    const destino = email.trim();
    if (!destino) {
      setMensagem({ tipo: "erro", texto: "Informe o e-mail usado no cadastro." });
      return;
    }
    if (!captcha.canSubmit) return;
    setEnviando(true);
    setMensagem(null);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: destino,
        options: { emailRedirectTo: confirmRedirectUrl(window.location.origin, from), captchaToken: captcha.consume() },
      });
      if (error) throw error;
      // O Supabase responde igual para e-mail inexistente ou já confirmado
      // (não revela quem tem conta) -- a mensagem não promete entrega.
      setMensagem({ tipo: "ok", texto: `Se houver um cadastro pendente para ${destino}, um novo link foi enviado. Confira também o spam.` });
      setEspera(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      if (isResendRateLimit(error)) {
        const s = resendWaitSeconds(error);
        setEspera(s);
        setMensagem({ tipo: "erro", texto: `Muitos envios em pouco tempo. Aguarde ${s} segundos para pedir outro link.` });
      } else {
        setMensagem({ tipo: "erro", texto: authErrorMessage(error, "Não foi possível reenviar o link. Tente de novo.") });
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-3">
      {pedirEmail && (
        <div>
          <Label htmlFor="reenviar-email" className="text-sm text-slate-600 dark:text-slate-300">E-mail do cadastro</Label>
          <Input id="reenviar-email" type="email" autoComplete="email" value={email}
            onChange={(e) => setEmail(e.target.value)} placeholder="email@empresa.com"
            className="mt-1.5 h-11 rounded-card" />
        </div>
      )}
      {captcha.widget}
      <Button type="button" variant="outline" onClick={reenviar} disabled={enviando || espera > 0 || !captcha.canSubmit}
        className="h-11 w-full gap-2 rounded-card">
        {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        {espera > 0 ? `Reenviar link em ${espera}s` : "Reenviar link de confirmação"}
      </Button>
      {mensagem && (
        <p role={mensagem.tipo === "erro" ? "alert" : "status"} className={`text-sm ${
          mensagem.tipo === "erro" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"
        }`}>
          {mensagem.texto}
        </p>
      )}
    </div>
  );
}
