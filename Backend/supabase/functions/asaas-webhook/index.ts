// Edge Function: asaas-webhook (Resumo.md §232). PREPARADA, NÃO PUBLICADA.
//
// Recebe as notificações do Asaas. Autenticação PRÓPRIA: header
// asaas-access-token = secret ASAAS_WEBHOOK_TOKEN (>= 32 caracteres,
// diferente da chave da API), comparado em tempo constante. Sem token
// válido: 401 e nada é gravado.
//
// O corpo do evento não é confiado: o status vem de um GET /payments/{id}
// no Asaas, e quem decide ativar/estornar é billing_apply_gateway_payment
// no banco (cobrança criada por nós, cliente, referência, valor e ambiente
// conferidos; um pagamento vira benefício UMA vez). Eventos repetidos
// (entrega "at least once") são deduplicados por id em webhook_events.
//
// Deploy SEM verificação de JWT (o Asaas não manda JWT):
//   supabase functions deploy asaas-webhook --no-verify-jwt
// Secrets: ASAAS_ENVIRONMENT, ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN.
// No painel do Asaas: Integrações -> Webhooks -> URL
//   https://<projeto>.supabase.co/functions/v1/asaas-webhook
//   com o MESMO token em "Token de autenticação"; eventos PAYMENT_*.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAsaasClient, handleWebhook, readAsaasConfig } from "../_shared/asaas.js";
import { supabaseKeys } from "../_shared/supabaseKeys.js";

const keys = supabaseKeys(Deno.env);

Deno.serve(async (req) => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const cfg = readAsaasConfig(Deno.env, "webhook");
  if (!cfg.ok) {
    console.error(JSON.stringify({ level: "error", message: "asaas-webhook não configurado", reason: cfg.reason }));
    return json(503, { error: "not_configured" });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  if (!keys.url || !keys.serviceKey) {
    console.error(JSON.stringify({ level: "error", message: "chaves do Supabase ausentes no ambiente da função" }));
    return json(503, { error: "not_configured" });
  }
  const admin = createClient(keys.url, keys.serviceKey, {
    auth: { persistSession: false },
  });

  try {
    const out = await handleWebhook({
      token: req.headers.get("asaas-access-token"),
      body,
      config: cfg.config,
      db: { rpc: (name: string, args: Record<string, unknown>) => admin.rpc(name, args) },
      // Timeout curto: a resposta ao Asaas precisa sair em ~10 s no total.
      asaas: createAsaasClient({ config: cfg.config, timeoutMs: 5000 }),
    });
    // Toda falha fica no log: 15 falhas seguidas pausam a fila no Asaas.
    if (out.status !== 200 || out.log) {
      console[out.status >= 500 ? "error" : "info"](JSON.stringify({ level: out.status >= 500 ? "error" : "info",
        message: "asaas-webhook", status: out.status, ...(out.log ?? {}) }));
    }
    return json(out.status, out.body);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", message: "asaas-webhook falhou", error: String((e as Error)?.message).slice(0, 200) }));
    return json(500, { error: "internal" });
  }
});
