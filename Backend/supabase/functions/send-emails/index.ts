// Edge Function: send-emails (seções 209 e 222).
//
// Processa a fila public.email_outbox e entrega pela Brevo. NÃO é uma API
// de envio: não aceita destinatário, assunto nem corpo. Só duas ações:
//   POST {}                 -> processa um lote da fila
//   POST {"action":"test"}  -> manda o e-mail de teste para EMAIL_TEST_TO
// As duas exigem o header x-email-worker-secret = EMAIL_WORKER_SECRET. Quem
// chama é o pg_cron (supabase/transactional-emails.sql) ou você, via
// scripts/email-teste-brevo.mjs.
//
// Deploy SEM verificação de JWT (quem autentica é o segredo acima):
//   supabase functions deploy send-emails --no-verify-jwt
//
// Secrets (supabase secrets set ...) -- NUNCA no React/Vite/.env.local:
//   BREVO_API_KEY, EMAIL_FROM (remetente verificado na Brevo), APP_URL,
//   EMAIL_WORKER_SECRET (>= 32 caracteres),
//   EMAIL_SENDING_MODE (disabled|test|live, padrão test), EMAIL_TEST_TO,
//   EMAIL_REPLY_TO (opcional), EMAIL_ENABLE_PAYMENT_EMAILS (padrão false),
//   EMAIL_BATCH_SIZE (padrão 20), EMAIL_PER_USER_PER_HOUR (padrão 10).
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY o Supabase já injeta.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  authorizeWorker,
  processBatch,
  readConfig,
  sendTestEmail,
  sendViaBrevo,
} from "../_shared/emailWorker.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Log sem segredo: só nível, mensagem e campos já mascarados pelo worker.
const log = (level: string, message: string, extra: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ level, message, ...extra });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = authorizeWorker(Deno.env.get("EMAIL_WORKER_SECRET") ?? "", req.headers.get("x-email-worker-secret"));
  if (!auth.ok) {
    if (auth.status === 500) log("error", "Configuração do segredo", { problema: auth.problem });
    return json(auth.status, { error: auth.error });
  }

  let body: { action?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const config = readConfig((k: string) => Deno.env.get(k) ?? "");
  const send = (msg: { to: string; subject: string; html: string; text: string; idempotencyKey?: string }) =>
    sendViaBrevo({ apiKey: config.apiKey, from: config.from, replyTo: config.replyTo, ...msg });

  if (body.action === "test") {
    const result = await sendTestEmail({ config, send });
    log(result.ok ? "info" : "warn", "Envio de teste", { ok: result.ok, status: result.status ?? null, code: result.code ?? null });
    return json(result.ok ? 200 : 502, result);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const claim = async (limit: number, perUserPerHour: number) => {
    const { data, error } = await supabase.rpc("email_outbox_claim", { p_limit: limit, p_per_user_hour: perUserPerHour });
    if (error) throw new Error(`claim: ${error.message}`);
    return data ?? [];
  };

  const finish = async (
    id: string,
    r: { status: string; error?: string; providerId?: string; retryAfterSeconds?: number; keepAttempt?: boolean },
  ) => {
    const { error } = await supabase.rpc("email_outbox_finish", {
      p_id: id,
      p_status: r.status,
      p_error: r.error ?? null,
      p_provider_id: r.providerId ?? null,
      p_retry_after_seconds: r.retryAfterSeconds ?? null,
      p_count_attempt: r.keepAttempt !== false,
    });
    if (error) log("error", "finish falhou", { id, error: error.message });
  };

  try {
    const resumo = await processBatch({ config, claim, finish, send, log });
    log("info", "Lote processado", resumo);
    return json(200, resumo);
  } catch (error) {
    log("error", "Lote falhou", { error: String((error as Error)?.message ?? error).slice(0, 300) });
    return json(500, { error: "batch_failed" });
  }
});
