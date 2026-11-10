// Gera os templates do Supabase Auth (Authentication -> Emails -> Templates)
// com a mesma moldura dos e-mails transacionais (seção 209).
//
//   node scripts/gerar-templates-auth.mjs
//
// Saída em supabase/email/auth/*.html -- para COLAR no painel. Não chama
// nada remoto. Os {{ .ConfirmationURL }} são do Supabase e levam o
// redirecionamento que o app pede (emailRedirectTo / redirectTo), então
// /ConfirmarEmail e /Login?recuperar=1 continuam funcionando em localhost.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../../Backend/supabase/functions/_shared/emailTemplates.js";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const destino = join(raiz, "..", "Backend", "supabase", "email", "auth");
mkdirSync(destino, { recursive: true });

const botao = (rotulo) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px">
  <tr><td style="border-radius:10px;background:#F94F0C">
    <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:13px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:10px">${rotulo}</a>
  </td></tr>
</table>`;

const nota = (t) => `<p style="margin:16px 0 0;color:#6B5F57;font-size:13px">${t}</p>`;

const TEMPLATES = {
  "confirm-signup": {
    assunto: "Confirme seu e-mail no NEXAR",
    titulo: "Confirme seu e-mail",
    corpo: `<p style="margin:0 0 12px">Falta só um passo para ativar sua conta no NEXAR: confirme que este e-mail é seu.</p>
${botao("Confirmar meu e-mail")}
${nota("Se você não criou uma conta no NEXAR, ignore este e-mail.")}`,
  },
  "reset-password": {
    assunto: "Redefinir sua senha do NEXAR",
    titulo: "Redefinir senha",
    corpo: `<p style="margin:0 0 12px">Recebemos um pedido para redefinir a senha da sua conta no NEXAR.</p>
${botao("Definir nova senha")}
${nota("Se não foi você, ignore este e-mail: sua senha continua a mesma.")}`,
  },
  "change-email": {
    assunto: "Confirme seu novo e-mail no NEXAR",
    titulo: "Confirme a troca de e-mail",
    corpo: `<p style="margin:0 0 12px">Você pediu para trocar o e-mail da sua conta de <strong>{{ .Email }}</strong> para <strong>{{ .NewEmail }}</strong>.</p>
${botao("Confirmar novo e-mail")}
${nota("Se não foi você, ignore este e-mail e troque sua senha.")}`,
  },
};

for (const [nome, t] of Object.entries(TEMPLATES)) {
  const html = layout({ preheader: t.titulo, titulo: t.titulo, corpoHtml: t.corpo, appUrl: "{{ .SiteURL }}" });
  writeFileSync(join(destino, `${nome}.html`), html);
  console.log(`${nome}.html  (assunto: ${t.assunto})`);
}
