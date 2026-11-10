// Edge Function: billing-reconcile (Resumo.md §233). PREPARADA, NÃO PUBLICADA
// E NÃO AGENDADA.
//
// Recupera o que o webhook não resolveu: eventos 'pending'/'failed' parados
// (o Asaas para de reenviar depois de 15 falhas seguidas ou 14 dias) e
// cobranças pendentes sem notícia há 15 min (fila pausada). Re-consulta cada
// cobrança no Asaas e aplica pelo MESMO billing_apply_gateway_payment do
// webhook -- idempotente, então rodar a mais não concede nada de novo.
//
//   POST   header x-billing-reconcile-secret: <BILLING_RECONCILE_SECRET>
//   -> 200 { checked, processed, failed, ignored }
//
// Deploy SEM JWT (quem chama é um agendador):
//   supabase functions deploy billing-reconcile --no-verify-jwt --project-ref <teste>
// Secrets: ASAAS_ENVIRONMENT, ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN (só para
// conferir que não se repete) e BILLING_RECONCILE_SECRET (>= 32, exclusivo --
// se repetir a chave ou o token do webhook, a função recusa com 503).
// Corpo opcional: { "limit": 1..200, "source": "cron" }. Uma execução por vez
// (billing_reconcile_begin): uma concorrente responde { skipped: true }.
// Agendamento: supabase/billing-reconcile-cron.sql (NÃO rodado; só num projeto
// de teste com billing_config.accepted_environment preenchido).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAsaasClient, handleReconcile, readAsaasConfig } from "../_shared/asaas.js";
import { supabaseKeys } from "../_shared/supabaseKeys.js";

const keys = supabaseKeys(Deno.env);

Deno.serve(async (req) => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const cfg = readAsaasConfig(Deno.env, "checkout");
  if (!cfg.ok) {
    console.error(JSON.stringify({ level: "error", message: "billing-reconcile não configurado", reason: cfg.reason }));
    return json(503, { error: "not_configured" });
  }
  if (!keys.url || !keys.serviceKey) {
    console.error(JSON.stringify({ level: "error", message: "chaves do Supabase ausentes no ambiente da função" }));
    return json(503, { error: "not_configured" });
  }
  const admin = createClient(keys.url, keys.serviceKey, {
    auth: { persistSession: false },
  });
  let body: { limit?: number; source?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    const out = await handleReconcile({
      secret: req.headers.get("x-billing-reconcile-secret"),
      expectedSecret: Deno.env.get("BILLING_RECONCILE_SECRET") ?? "",
      // O token do webhook entra só para conferir que o segredo NÃO o repete.
      config: { ...cfg.config, webhookToken: Deno.env.get("ASAAS_WEBHOOK_TOKEN") ?? null },
      limit: typeof body.limit === "number" ? body.limit : 50,
      source: typeof body.source === "string" ? body.source : "manual",
      db: { rpc: (name: string, args: Record<string, unknown>) => admin.rpc(name, args) },
      asaas: createAsaasClient({ config: cfg.config, timeoutMs: 5000 }),
    });
    if (out.status !== 200 || (out.body as { failed?: number }).failed) {
      console.warn(JSON.stringify({ level: "warn", message: "billing-reconcile", status: out.status, ...(out.body as object) }));
    }
    return json(out.status, out.body);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "billing-reconcile falhou", error: String((e as Error)?.message).slice(0, 200) }));
    return json(500, { error: "internal" });
  }
});
