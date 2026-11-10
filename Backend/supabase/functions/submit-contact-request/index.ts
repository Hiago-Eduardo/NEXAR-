// Edge Function: submit-contact-request (Resumo.md §228). PREPARADA, NÃO
// PUBLICADA.
//
// O pedido de orçamento protegido por Turnstile. A função NÃO é um
// "validador de CAPTCHA": ela confere o token na Cloudflare (Siteverify) E
// grava o pedido, na mesma requisição. Depois de rodar
// supabase/contact-request-captcha-lock.sql o cliente não consegue mais
// inserir em contact_requests direto -- este é o único caminho.
//
//   POST { supplier_id, sender_name, sender_email, sender_phone, message, captchaToken }
//   Authorization: Bearer <JWT do usuário>   (o supabase-js manda sozinho)
//
// Deploy COM verificação de JWT (padrão; sem --no-verify-jwt):
//   supabase functions deploy submit-contact-request
//
// Secrets: TURNSTILE_SECRET_KEY (obrigatório), TURNSTILE_ALLOWED_HOSTNAMES
// (ex.: "nexar.com.br,www.nexar.com.br"), ALLOWED_ORIGINS (CORS, ex.:
// "https://nexar.com.br"). SUPABASE_URL, SUPABASE_ANON_KEY e
// SUPABASE_SERVICE_ROLE_KEY o Supabase injeta.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  captchaReasonMessage, parseHostnames, validateContactRequest, verifyTurnstile,
} from "../_shared/turnstile.js";

const allowedOrigins = parseHostnames(Deno.env.get("ALLOWED_ORIGINS"));

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const ok = allowedOrigins.length === 0 || allowedOrigins.includes(origin.toLowerCase());
  return {
    "Access-Control-Allow-Origin": ok ? origin || "*" : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1) Quem está pedindo: o usuário do JWT, nunca um campo do corpo.
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  // JWT explícito: getUser() sem argumento depende da versão do auth-js
  // (sem sessão salva, versões antigas devolvem AuthSessionMissingError).
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await asUser.auth.getUser(jwt);
  if (userError || !userData?.user) return json(401, { error: "unauthorized", message: "Faça login para pedir orçamento." });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_body" });
  }

  // 2) Campos: lista branca e tamanho máximo.
  const checked = validateContactRequest(body);
  if (!checked.ok) return json(400, { error: "invalid_fields", fields: checked.errors });

  // 3) CAPTCHA: falha fechada.
  const remoteip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const captcha = await verifyTurnstile({
    secret: Deno.env.get("TURNSTILE_SECRET_KEY") ?? "",
    token: body.captchaToken,
    remoteip,
    allowedHostnames: parseHostnames(Deno.env.get("TURNSTILE_ALLOWED_HOSTNAMES")),
    expectedAction: "contact_request",
  });
  if (!captcha.ok) {
    console.warn(JSON.stringify({ level: "warn", message: "captcha recusado", reason: captcha.reason, codes: captcha.codes }));
    const status = captcha.reason === "unavailable" || captcha.reason === "missing_secret" ? 503 : 400;
    return json(status, { error: "captcha_failed", reason: captcha.reason, message: captchaReasonMessage(captcha.reason) });
  }

  // 4) Gravação: RPC security definer só para service_role, com o usuário
  //    já conferido. Mesmas regras de antes (dono = quem pediu); o trigger do
  //    e-mail ao dono do anúncio continua disparando.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const v = checked.value;
  const { data, error } = await admin.rpc("submit_contact_request", {
    p_user: userData.user.id,
    p_supplier_id: v.supplier_id,
    p_sender_name: v.sender_name,
    p_sender_email: v.sender_email,
    p_sender_phone: v.sender_phone,
    p_message: v.message,
  });
  if (error) {
    const naoEncontrado = /SUPPLIER_NOT_FOUND/.test(error.message);
    console.error(JSON.stringify({ level: "error", message: "insert falhou", error: error.message.slice(0, 200) }));
    return json(naoEncontrado ? 404 : 500, {
      error: naoEncontrado ? "supplier_not_found" : "insert_failed",
      message: naoEncontrado ? "Este anúncio não está mais disponível." : "Não foi possível enviar o pedido. Tente de novo.",
    });
  }
  return json(200, { id: data });
});
