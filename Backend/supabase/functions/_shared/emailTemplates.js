// Templates de e-mail transacional do NEXAR (seção 209).
//
// JavaScript puro, sem dependência de Deno nem de Node: é importado pela Edge
// Function (supabase/functions/send-emails/index.ts) e pelos testes do
// Vitest (src/api/emailTemplates.test.js). Cada template devolve
// { subject, html, text } -- sempre as duas versões.
//
// Identidade: laranja da marca #F94F0C, cinza quente (paleta de
// tailwind.config.js, seção 71), logotipo "NEXAR" com o X laranja.
// HTML em tabela com estilos inline, largura máxima de 600 px: é o que os
// clientes de e-mail (Outlook, Gmail) renderizam de forma previsível.
//
// TUDO que vem de dado (nome, mensagem, título) passa por escapeHtml.

const COR = {
  laranja: "#F94F0C",
  laranjaEscuro: "#DC3D02",
  fundo: "#F3EFEB",
  cartao: "#FFFFFF",
  texto: "#211C19",
  suave: "#6B5F57",
  borda: "#E6DFD8",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cortar(value, max) {
  const s = String(value ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Link interno ("/Dashboard") vira absoluto; qualquer outra coisa é
// descartada -- nenhum dado consegue pôr um link externo no e-mail.
export function appLink(appUrl, path) {
  if (!path || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return String(appUrl || "").replace(/\/$/, "") || "";
  }
  return `${String(appUrl || "").replace(/\/$/, "")}${path}`;
}

function botao(href, rotulo) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 8px">
  <tr><td style="border-radius:10px;background:${COR.laranja}">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#FFFFFF;text-decoration:none;border-radius:10px">${escapeHtml(rotulo)}</a>
  </td></tr>
</table>`;
}

// Moldura comum: pré-cabeçalho escondido, logotipo, cartão, rodapé.
export function layout({ preheader, titulo, corpoHtml, appUrl }) {
  const site = String(appUrl || "").replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${COR.fundo}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.fundo}">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
      <tr><td style="padding:0 8px 20px;font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:900;letter-spacing:3px;color:${COR.texto}">
        NE<span style="color:${COR.laranja}">X</span>AR
      </td></tr>
      <tr><td style="background:${COR.cartao};border:1px solid ${COR.borda};border-radius:14px;padding:32px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${COR.texto}">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:${COR.texto}">${escapeHtml(titulo)}</h1>
        ${corpoHtml}
      </td></tr>
      <tr><td style="padding:20px 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:${COR.suave}">
        Você recebeu este e-mail porque tem uma conta no NEXAR${site ? ` (<a href="${escapeHtml(site)}" style="color:${COR.suave}">${escapeHtml(site.replace(/^https?:\/\//, ""))}</a>)` : ""}.
        Este é um e-mail automático; não responda.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function paragrafo(texto) {
  return `<p style="margin:0 0 12px">${escapeHtml(texto)}</p>`;
}

function textoFinal(linhas, link, rotulo) {
  return [...linhas, "", link ? `${rotulo}: ${link}` : "", "", "—", "NEXAR · e-mail automático, não responda."]
    .filter((l, i, arr) => !(l === "" && arr[i - 1] === ""))
    .join("\n")
    .trim();
}

function montar({ subject, preheader, titulo, paragrafos, link, rotulo, extraHtml = "", extraTexto = [], appUrl }) {
  const corpoHtml = paragrafos.map(paragrafo).join("") + extraHtml + (link ? botao(link, rotulo) : "");
  return {
    subject,
    html: layout({ preheader, titulo, corpoHtml, appUrl }),
    text: textoFinal([titulo, "", ...paragrafos, ...extraTexto], link, rotulo),
  };
}

const nomeOu = (nome, padrao = "") => cortar(nome, 80) || padrao;

// --------------------------------------------------------------------------
// Templates. `data` vem do e-mail_outbox (gravado pelo banco), nunca do
// cliente; mesmo assim tudo é cortado e escapado.
// --------------------------------------------------------------------------

const TEMPLATES = {
  welcome(data, { appUrl }) {
    const nome = nomeOu(data.full_name);
    const fornecedor = data.user_type === "fornecedor";
    return montar({
      appUrl,
      subject: "Bem-vindo ao NEXAR",
      preheader: "Sua conta está confirmada.",
      titulo: nome ? `Bem-vindo ao NEXAR, ${nome}!` : "Bem-vindo ao NEXAR!",
      paragrafos: fornecedor
        ? ["Seu e-mail foi confirmado e sua conta de fornecedor está ativa.",
           "O próximo passo é escolher um plano e publicar seu primeiro anúncio para ser encontrado por empresas de todo o Brasil."]
        : ["Seu e-mail foi confirmado e sua conta está ativa.",
           "Encontre fornecedores, compare propostas e peça orçamentos direto pela plataforma."],
      link: appLink(appUrl, fornecedor ? "/Planos?onboarding=1" : "/Suppliers"),
      rotulo: fornecedor ? "Escolher meu plano" : "Ver fornecedores",
    });
  },

  quote_request(data, { appUrl }) {
    const anuncio = nomeOu(data.supplier_name, "seu anúncio");
    const remetente = nomeOu(data.sender_name, "Uma empresa");
    const trecho = cortar(data.message_excerpt, 300);
    return montar({
      appUrl,
      subject: `Nova solicitação de orçamento para ${anuncio}`,
      preheader: `${remetente} pediu um orçamento.`,
      titulo: "Nova solicitação de orçamento",
      paragrafos: [`${remetente} pediu um orçamento pelo anúncio "${anuncio}".`],
      extraHtml: trecho
        ? `<blockquote style="margin:4px 0 12px;padding:12px 16px;border-left:3px solid ${COR.laranja};background:${COR.fundo};border-radius:6px;color:${COR.texto}">${escapeHtml(trecho)}</blockquote>
<p style="margin:0 0 12px;color:${COR.suave};font-size:13px">Os dados de contato estão no seu painel.</p>`
        : `<p style="margin:0 0 12px;color:${COR.suave};font-size:13px">Os dados de contato estão no seu painel.</p>`,
      extraTexto: trecho ? ["", `"${trecho}"`, "", "Os dados de contato estão no seu painel."] : ["Os dados de contato estão no seu painel."],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Ver pedido no painel",
    });
  },

  platform_notification(data, { appUrl }) {
    const titulo = cortar(data.title, 120) || "Aviso do NEXAR";
    return montar({
      appUrl,
      subject: titulo,
      preheader: cortar(data.body, 120),
      titulo,
      paragrafos: data.body ? [cortar(data.body, 1000)] : [],
      link: appLink(appUrl, data.link || "/Notificacoes"),
      rotulo: "Abrir no NEXAR",
    });
  },

  subscription_activated(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Seu plano no NEXAR está ativo",
      preheader: cortar(data.body, 120) || "Plano ativado.",
      titulo: "Plano ativado",
      paragrafos: [cortar(data.body, 500) || "Seu plano está ativo e seus anúncios já podem ser publicados."],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Ir para o painel",
    });
  },

  subscription_expiring(data, { appUrl }) {
    const quando = cortar(data.expires_on, 20);
    return montar({
      appUrl,
      subject: "Seu plano no NEXAR vence em breve",
      preheader: quando ? `Seu plano termina em ${quando}.` : "Seu plano termina em breve.",
      titulo: "Seu plano vence em breve",
      paragrafos: [
        quando ? `Sua assinatura foi cancelada e o plano termina em ${quando}.` : "Sua assinatura foi cancelada e o plano termina em breve.",
        "Depois disso seus anúncios e produtos ficam suspensos — nada é apagado. Se mudou de ideia, você pode reativar antes do fim.",
      ],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Reativar assinatura",
    });
  },

  subscription_expired(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Sua assinatura do NEXAR foi encerrada",
      preheader: "Seus anúncios estão suspensos.",
      titulo: "Assinatura encerrada",
      paragrafos: [cortar(data.body, 500) || "Você está sem plano. Seus anúncios e produtos ficam suspensos até você assinar de novo — nada foi apagado."],
      link: appLink(appUrl, "/Planos"),
      rotulo: "Ver planos",
    });
  },

  subscription_suspended(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Sua assinatura do NEXAR foi suspensa",
      preheader: "Ação necessária na sua assinatura.",
      titulo: "Assinatura suspensa",
      paragrafos: [cortar(data.body, 500) || "Sua assinatura foi suspensa e seus anúncios saíram do ar até a situação ser regularizada."],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Ver minha assinatura",
    });
  },

  subscription_cancelled(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Cancelamento da assinatura confirmado",
      preheader: "Seu plano continua até o fim do período.",
      titulo: "Assinatura cancelada",
      paragrafos: [cortar(data.body, 500) || "Seu cancelamento foi registrado. O plano continua valendo até o fim do período já pago."],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Ver minha assinatura",
    });
  },

  // Pagamentos: só templates. O gateway não existe ainda, e a Edge Function
  // RECUSA estes dois enquanto EMAIL_ENABLE_PAYMENT_EMAILS não for "true".
  payment_confirmed(data, { appUrl }) {
    const valor = cortar(data.amount_label, 30);
    return montar({
      appUrl,
      subject: "Pagamento confirmado — NEXAR",
      preheader: valor ? `Recebemos ${valor}.` : "Recebemos seu pagamento.",
      titulo: "Pagamento confirmado",
      paragrafos: [valor ? `Recebemos seu pagamento de ${valor}. Obrigado!` : "Recebemos seu pagamento. Obrigado!"],
      link: appLink(appUrl, "/Dashboard"),
      rotulo: "Ver minha assinatura",
    });
  },

  payment_failed(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Não conseguimos processar seu pagamento — NEXAR",
      preheader: "Atualize sua forma de pagamento.",
      titulo: "Falha no pagamento",
      paragrafos: [
        "Não conseguimos processar o pagamento da sua assinatura.",
        "Confira sua forma de pagamento para evitar a suspensão dos anúncios.",
      ],
      link: appLink(appUrl, "/Pagamento"),
      rotulo: "Atualizar pagamento",
    });
  },

  test(data, { appUrl }) {
    return montar({
      appUrl,
      subject: "Teste de envio — NEXAR",
      preheader: "Se você recebeu, o envio está funcionando.",
      titulo: "Teste de envio",
      paragrafos: [
        "Este é um e-mail de teste da integração do NEXAR com a Brevo.",
        `Enviado em ${cortar(data.sent_at, 40) || "agora"}.`,
      ],
      link: appLink(appUrl, "/"),
      rotulo: "Abrir o NEXAR",
    });
  },
};

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));
export const PAYMENT_TEMPLATES = Object.freeze(["payment_confirmed", "payment_failed"]);

export function renderEmail(template, data = {}, { appUrl = "" } = {}) {
  const fn = TEMPLATES[template];
  if (!fn) throw new Error(`Template desconhecido: ${template}`);
  return fn(data || {}, { appUrl });
}
