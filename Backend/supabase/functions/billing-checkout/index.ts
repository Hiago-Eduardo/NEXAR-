// Edge Function: billing-checkout (Resumo.md §232). PREPARADA, NÃO PUBLICADA.
//
// Gera (ou reaproveita) a cobrança do Asaas de um plano pago e devolve o
// link da fatura. NÃO ativa nada: a ativação só acontece no webhook, depois
// que o Asaas confirma o pagamento.
//
//   POST { plan_id: "profissional" | "premium" }
//   Authorization: Bearer <JWT do usuário>   (o supabase-js manda sozinho)
//   -> 200 { invoiceUrl }
//
// Deploy COM verificação de JWT: supabase functions deploy billing-checkout
// Secrets: ASAAS_ENVIRONMENT (sandbox|production), ASAAS_API_KEY,
// ALLOWED_ORIGINS. SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY o Supabase injeta. Ver supabase/functions/.env.example.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAsaasClient, handleCardPayment, handleCheckout, readAsaasConfig } from "../_shared/asaas.js";
import { parseHostnames } from "../_shared/turnstile.js";
import { supabaseKeys } from "../_shared/supabaseKeys.js";

// Chave legada (anon/service_role) ou a nova (publishable/secret "default").
const keys = supabaseKeys(Deno.env);

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

  // Quem paga: o usuário do JWT, nunca um campo do corpo.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!keys.url || !keys.publicKey || !keys.serviceKey) {
    console.error(JSON.stringify({ level: "error", message: "chaves do Supabase ausentes no ambiente da função" }));
    return json(503, { error: "billing_unavailable", message: "A contratação online ainda não está disponível." });
  }
  const asUser = createClient(keys.url, keys.publicKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await asUser.auth.getUser(jwt);
  if (userError || !userData?.user) return json(401, { error: "unauthorized", message: "Faça login para contratar." });

  const cfg = readAsaasConfig(Deno.env, "checkout");
  if (!cfg.ok) {
    console.error(JSON.stringify({ level: "error", message: "asaas não configurado", reason: cfg.reason }));
    return json(503, { error: "billing_unavailable", message: "A contratação online ainda não está disponível." });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_body" });
  }

  const admin = createClient(keys.url, keys.serviceKey, {
    auth: { persistSession: false },
  });
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => admin.rpc(name, args),
    profile: async (uid: string) => {
      const { data } = await admin.from("user_profiles").select("company_name, full_name, cnpj")
        .eq("created_by", uid).maybeSingle();
      return data;
    },
  };

  try {
    // method "card" (§240): cartão digitado no NEXAR. O corpo NUNCA vai
    // para log -- só o código do erro.
    const args = {
      user: { id: userData.user.id, email: userData.user.email },
      body,
      config: cfg.config,
      db,
      asaas: createAsaasClient({ config: cfg.config }),
    };
    const remoteIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
    const out = body?.method === "card"
      ? await handleCardPayment({ ...args, remoteIp })
      : await handleCheckout(args);
    if (out.status >= 400) {
      console.warn(JSON.stringify({ level: "warn", message: "checkout recusado", error: (out.body as { error?: string }).error }));
    }
    return json(out.status, out.body);
  } catch (e) {
    // AsaasError não carrega chave nem corpo da resposta -- só status/códigos.
    console.error(JSON.stringify({ level: "error", message: "checkout falhou", error: String((e as Error)?.message).slice(0, 200) }));
    return json(502, { error: "gateway_unavailable", message: "Não foi possível gerar a cobrança agora. Tente de novo." });
  }
});
