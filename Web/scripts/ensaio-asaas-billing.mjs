// Ensaio LOCAL de supabase/asaas-billing.sql + reaplicação dos SQL antigos
// (Resumo.md §232). Banco em memória (PGlite); NADA toca o Supabase real nem
// o Asaas -- o "Asaas" aqui são os valores que a Edge Function passaria
// depois de re-consultar a cobrança.
//
// 1) instala na ordem documentada: arquivos antigos -> fix-paid-plan-activation
//    -> asaas-billing (testes embutidos de cada um);
// 2) reaplica asaas-billing e fix (re-executáveis, inclusive os testes T8-T10
//    que agora precisam de pagamento aprovado);
// 3) re-roda, um a um, os 5 arquivos antigos e confere que a C1 continua
//    fechada (RPC, gatilho, privilégios, funções de cobrança);
// 4) jornada: Básico -> checkout -> confirmação -> Premium -> duplicado ->
//    estorno -> volta ao Básico; vencimento pela manutenção; linhas pagas
//    legadas (as 2 contas de 10/11).
//
// Uso: PGLITE=/caminho/.../pglite/dist/index.js node scripts/ensaio-asaas-billing.mjs
import { montarBanco } from "./lib/pglite-nexar.mjs";

const { db, ler, blocosDeFuncao, conta, como, tentar, um } = await montarBanco({ supabaseDefaultPrivileges: true });
let falhas = 0;
const ok = (nome, cond, extra = "") => {
  if (!cond) falhas++;
  console.log(`${cond ? "ok  " : "FALHOU"}  ${nome}${extra ? "  -- " + extra : ""}`);
};
const rodar = async (arquivo) => {
  try {
    const res = await db.exec(ler(arquivo));
    return Object.fromEntries(res.at(-1).rows.map((l) => [l.ordem, l.valor]));
  } catch (e) {
    await db.exec("rollback;").catch(() => {});
    return { erro: e.message };
  }
};
const reaplicarFuncoes = async (arquivo) => {
  const sql = ler(arquivo);
  for (const b of blocosDeFuncao(sql)) { try { await db.exec(b); } catch { /* dependência ausente */ } }
  for (const m of sql.matchAll(/^(?:drop trigger if exists [^;]+;|create trigger [\s\S]*?;)/gim)) { try { await db.exec(m[0]); } catch { /* idem */ } }
  for (const m of sql.matchAll(/^(?:revoke|grant) execute on (?:function|procedure) [^;]+;/gim)) { try { await db.exec(m[0]); } catch { /* idem */ } }
};

// As 2 contas Profissional do banco vivo: linhas pagas SEM payment_id.
const legadas = [];
for (let i = 0; i < 2; i++) {
  const u = await conta();
  legadas.push(u);
  await db.exec(`insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, next_charge_at)
                 values ('${u}', 'profissional', 'active', now() - interval '15 days', public.next_billing_date(now()), public.next_billing_date(now()));`);
}

// ------------------------------------------------------------- 1) instala
console.log("\n== 1) instalação na ordem: antigos -> fix-paid-plan-activation -> asaas-billing");
let r = await rodar("fix-paid-plan-activation.sql");
ok("fix-paid-plan-activation: testes embutidos", r[1] === "20/20 testes ok", r[1] ?? r.erro);
r = await rodar("asaas-billing.sql");
ok("asaas-billing: testes embutidos", r[1] === "31/31 testes ok", r[1] ?? r.erro);
ok("asaas-billing: ambiente aceito continua NULL (cobrança desligada)", r[2] === "NULL", r[2]);
ok("asaas-billing: gatilho ligado", r[3] === "ligado", r[3]);
ok("asaas-billing: nenhuma função de cobrança para o cliente", r[4] === "nenhuma", r[4]);

// --------------------------------------------------------- 2) reaplicação
console.log("\n== 2) reaplicação (re-executáveis)");
r = await rodar("asaas-billing.sql");
ok("asaas-billing de novo", r[1] === "31/31 testes ok", r[1] ?? r.erro);
r = await rodar("fix-paid-plan-activation.sql");
ok("fix-paid-plan-activation de novo, com o gatilho instalado (T8-T10 com pagamento)", r[1] === "20/20 testes ok", r[1] ?? r.erro);

// ------------------------------------------ 3) arquivos antigos re-rodados
console.log("\n== 3) re-rodar cada arquivo antigo não reabre a C1");
const c1Fechada = async (rotulo) => {
  const u = await conta();
  const rpc = await tentar(`${como(u)} select public.subscribe_to_plan('premium');`);
  let direto = "";
  try {
    await db.exec(`insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
                   values ('${u}', 'premium', 'active', now(), now() + interval '30 days');`);
    direto = "PASSOU";
  } catch (e) { direto = e.message; }
  const priv = await um(`select string_agg(r || ':' || t || ':' || p, ' ') v
    from unnest(array['subscriptions','payments','payment_attempts','webhook_events','subscription_events','billing_config','billing_customers']) t
    cross join unnest(array['anon','authenticated']) r cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p
    where has_table_privilege(r, 'public.' || t, p)`);
  const fn = await um(`select string_agg(p.proname, ',') v from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname like 'billing\\_%' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
  const pago = await um(`select count(*)::int n from public.subscriptions where created_by = $1 and plan_id <> 'basico'`, [u]);
  ok(`${rotulo}: RPC recusa, gatilho recusa, sem escrita/execução do cliente`,
    /PAYMENT_REQUIRED/.test(rpc) && /PAYMENT_REQUIRED/.test(direto) && !priv.v && !fn.v && pago.n === 0,
    JSON.stringify({ rpc: rpc.slice(0, 40), direto: direto.slice(0, 40), priv: priv.v, fn: fn.v }));
};
for (const f of ["rls-policies.sql", "subscription-plan-change.sql", "plan-change-at-period-end.sql",
                 "billing-cycle-day-10.sql", "plan-limits-central.sql"]) {
  await reaplicarFuncoes(f);
  await c1Fechada(`depois de re-rodar ${f}`);
}
// Caminho documentado depois de re-rodar arquivo antigo: central -> fix.
await reaplicarFuncoes("plan-limits-central.sql");
for (const f of ["plan-limits-ux.sql", "fix-downgrade-ended-notification.sql"]) await reaplicarFuncoes(f);
r = await rodar("fix-paid-plan-activation.sql");
ok("caminho documentado (central -> fix) volta a passar", r[1] === "20/20 testes ok", r[1] ?? r.erro);
await c1Fechada("estado final");

// ------------------------------------------------------------- 4) jornada
console.log("\n== 4) jornada local (ambiente aceito = sandbox SÓ neste banco)");
await db.exec(`update public.billing_config set accepted_environment = 'sandbox';`);
const svc = async (sql, p = []) => {
  await db.exec("set role service_role;");
  try { return (await db.query(sql, p)).rows[0]; } finally { await db.exec("reset role;"); }
};
const asaasDiz = (p, status, extra = {}) => svc(
  `select public.billing_apply_gateway_payment('sandbox', $1, $2, $3, $4, $5, $6) r`,
  [p.gateway_payment_id, status, extra.value ?? p.amount_cents / 100, extra.customer ?? p.gateway_customer_id,
   extra.ref ?? p.id, extra.deleted ?? false]);
{
  const u = await conta();
  let x = await tentar(`${como(u)} select public.subscribe_to_plan('basico');`);
  ok("assina o Básico pela RPC", x === "ok", x);
  x = await tentar(`${como(u)} insert into public.suppliers (created_by, business_name) values ('${u}', 'a1');`);
  const x2 = await tentar(`${como(u)} insert into public.suppliers (created_by, business_name) values ('${u}', 'a2');`);
  ok("Básico: 1 anúncio, o 2º bate no limite", x === "ok" && /PLAN_LIMIT/.test(x2), x2);

  const prep = await svc(`select public.billing_prepare_checkout($1, 'premium', 'sandbox') j`, [u]);
  ok("checkout prepara cobrança com preço/período do banco", prep.j.amount_cents === 9900 && !prep.j.reused, JSON.stringify(prep.j));
  const pid = prep.j.payment_id;
  await svc(`select public.billing_customer_save($1, 'sandbox', 'cus_local_1')`, [u]);
  await svc(`select public.billing_attach_gateway_charge($1, 'pay_local_1', 'cus_local_1', 'https://sandbox.asaas.com/i/x')`, [pid]);
  let p = await um(`select * from public.payments where id = $1`, [pid]);
  ok("cobrança criada NÃO ativa nada", (await um(`select public.fornecedor_current_plan_id($1) p`, [u])).p === "basico");

  let a = await asaasDiz(p, "PENDING");
  ok("PENDING não ativa", a.r.result === "pending");
  a = await asaasDiz(p, "CONFIRMED");
  ok("CONFIRMED ativa o Premium até o próximo dia 10", a.r.result === "activated", JSON.stringify(a.r));
  const sub = await um(`select plan_id, expires_at = public.next_billing_date(now()) certo from public.subscriptions where created_by = $1 and status = 'active'`, [u]);
  ok("plano e período corretos", sub.plan_id === "premium" && sub.certo === true, JSON.stringify(sub));
  x = await tentar(`${como(u)} insert into public.suppliers (created_by, business_name) values ('${u}', 'a3'), ('${u}', 'a4');`);
  const plano = await um(`select count(*) filter (where status = 'active')::int ativos, min(plan) pl from public.suppliers where created_by = $1`, [u]);
  ok("Premium libera mais anúncios e o plano do anúncio é sincronizado", x === "ok" && plano.ativos >= 3 && plano.pl === "premium", JSON.stringify(plano));

  a = await asaasDiz(p, "RECEIVED");
  const n = await um(`select count(*)::int n from public.subscriptions where created_by = $1 and plan_id = 'premium'`, [u]);
  ok("RECEIVED depois de CONFIRMED não concede de novo", a.r.result === "already_applied" && n.n === 1);

  x = await tentar(`${como(u)} select public.billing_apply_gateway_payment('sandbox', 'pay_local_1', 'RECEIVED', 99, 'cus_local_1', '${pid}');`);
  ok("o cliente não chama o motor (42501)", /permission denied/.test(x), x);

  a = await asaasDiz(p, "REFUNDED");
  const depois = await um(`select public.fornecedor_current_plan_id($1) p,
      (select count(*) from public.suppliers where created_by = $1 and suspension_reason = 'no_plan')::int susp`, [u]);
  ok("estorno: benefício acaba e a central suspende (no_plan)", a.r.result === "reversed" && depois.p === null && depois.susp === 3, JSON.stringify(depois));
  x = await tentar(`${como(u)} select public.subscribe_to_plan('basico');`);
  const volta = await um(`select count(*) filter (where status = 'active')::int a from public.suppliers where created_by = $1`, [u]);
  ok("volta ao Básico: 1 anúncio no ar", x === "ok" && volta.a === 1, `${x} ${JSON.stringify(volta)}`);
}
{
  // Vencimento: nada renova sozinho -- a manutenção só expira.
  const u = await conta();
  const prep = await svc(`select public.billing_prepare_checkout($1, 'profissional', 'sandbox') j`, [u]);
  await svc(`select public.billing_customer_save($1, 'sandbox', 'cus_local_2')`, [u]);
  await svc(`select public.billing_attach_gateway_charge($1, 'pay_local_2', 'cus_local_2', null)`, [prep.j.payment_id]);
  const p = await um(`select * from public.payments where id = $1`, [prep.j.payment_id]);
  await asaasDiz(p, "RECEIVED");
  await db.exec(`update public.subscriptions set expires_at = now() - interval '1 second' where created_by = '${u}' and status = 'active';`);
  const m = await um(`select public.run_plan_maintenance() j`);
  const s = await um(`select count(*) filter (where status = 'active')::int ativas, count(*)::int total from public.subscriptions where created_by = $1`, [u]);
  ok("vencimento pela manutenção: expira, não cria período novo", s.ativas === 0 && s.total === 1 && m.j.failed === 0, JSON.stringify(s));
}
{
  // As 2 linhas Profissional legadas (sem payment_id).
  const [u1, u2] = legadas;
  let x = await tentar(`${como(u1)} select public.cancel_my_subscription(); select public.reactivate_my_subscription();`);
  ok("legada: cancelar e reativar funcionam", x === "ok", x);
  let y = "";
  try { await db.exec(`update public.subscriptions set expires_at = expires_at + interval '30 days' where created_by = '${u2}';`); y = "PASSOU"; }
  catch (e) { y = e.message; }
  ok("legada: estender o período é recusado", /PAYMENT_REQUIRED/.test(y), y);
  await db.exec(`update public.subscriptions set expires_at = now() - interval '1 second' where created_by in ('${u1}', '${u2}');`);
  const m = await um(`select public.run_plan_maintenance() j`);
  const s = await um(`select string_agg(status, ',' order by status) v from public.subscriptions where created_by in ('${u1}', '${u2}')`);
  ok("legada: em 10/11 a manutenção expira as duas sem erro", s.v === "expired,expired" && m.j.failed === 0, JSON.stringify({ s, m: m.j }));
}
{
  const a = await svc(`select public.billing_webhook_begin('evt_1', 'PAYMENT_RECEIVED', '{}') v`);
  const b = await svc(`select public.billing_webhook_begin('evt_1', 'PAYMENT_RECEIVED', '{}') v`);
  await svc(`select public.billing_webhook_finish('evt_1', 'processed')`);
  const c = await svc(`select public.billing_webhook_begin('evt_1', 'PAYMENT_RECEIVED', '{}') v`);
  ok("webhook: reenvio antes de terminar reprocessa; depois de processado é duplicado", a.v === "process" && b.v === "process" && c.v === "duplicate");
  const x = await tentar(`${como(legadas[0])} select public.billing_webhook_begin('evt_2', 'X', '{}');`);
  ok("webhook: cliente não grava evento (42501)", /permission denied/.test(x), x);
}

// ------------------------------------------------------------------------
// 5) INTEGRAÇÃO (§233): o código REAL das Edge Functions (handleCheckout,
//    handleWebhook, handleReconcile) contra ESTE banco, com um Asaas FALSO
//    em memória. Cada RPC numa transação própria como service_role (como
//    o PostgREST); chamadas em paralelo se intercalam nos awaits.
// ------------------------------------------------------------------------
console.log("\n== 5) integração: handlers reais + banco local + Asaas falso");
const { handleCheckout, handleWebhook, handleReconcile, AsaasError } = await import("../../Backend/supabase/functions/_shared/asaas.js");
const cfgAsaas = { environment: "sandbox", baseUrl: "x", apiKey: "$aact_hmlg_x", webhookToken: "w".repeat(40) };
// Funções que devolvem TABELA: o supabase-js entrega lista de linhas.
const SEM_TABELA = new Set(["billing_reconcile_candidates", "billing_charge_ownership"]);
const dbReal = {
  rpc: async (name, args) => {
    const keys = Object.keys(args ?? {});
    const chamada = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    try {
      const rows = await db.transaction(async (tx) => {
        await tx.exec("set local role service_role;");
        const r = await tx.query(SEM_TABELA.has(name) ? `select * from ${chamada}` : `select ${chamada} as r`,
          keys.map((k) => args[k]));
        return r.rows;
      });
      return { data: SEM_TABELA.has(name) ? rows : rows[0]?.r ?? null, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message } };
    }
  },
  profile: async () => ({ company_name: "Empresa Teste", cnpj: "12345678000195" }),
};
// Ids únicos entre instâncias, como no Asaas de verdade.
let n = 0;
function asaasFalso() {
  const cobr = new Map();
  const clientes = new Map();
  const pausa = () => new Promise((r) => setTimeout(r, 5));
  const f = {
    cobr, fora: false, pagarAoRemover: false,
    async findCustomerByExternalReference(ref) { await pausa(); return [...clientes.values()].find((c) => c.externalReference === ref) ?? null; },
    async createCustomer(p) { await pausa(); const c = { id: `cus_${++n}`, ...p }; clientes.set(c.id, c); return c; },
    async findPaymentByExternalReference(ref) { await pausa(); return [...cobr.values()].find((p) => p.externalReference === ref && !p.deleted) ?? null; },
    async createPayment(p) {
      await pausa();
      const c = { id: `pay_${++n}`, status: "PENDING", deleted: false, invoiceUrl: `https://sandbox.asaas.com/i/${n}`, ...p };
      cobr.set(c.id, c);
      return { ...c };
    },
    async getPayment(id) {
      await pausa();
      if (f.fora) throw new AsaasError(503);
      const c = cobr.get(id);
      if (!c) throw new AsaasError(404);
      return { ...c };
    },
    async deletePayment(id) {
      await pausa();
      const c = cobr.get(id);
      if (!c) throw new AsaasError(404);
      if (f.pagarAoRemover) c.status = "RECEIVED";            // pago um instante antes
      if (["RECEIVED", "CONFIRMED"].includes(c.status)) throw new AsaasError(400, ["invalid_action"]);
      c.deleted = true;
      return { deleted: true, id };
    },
  };
  return f;
}
const novoFornecedor = async () => {
  const u = await conta();
  await db.exec(`update auth.users set raw_user_meta_data = '{"user_type":"fornecedor"}' where id = '${u}';`);
  return { id: u, email: `${u}@nexar.test` };
};
const checkout = (asaas, user, plan_id) => handleCheckout({ user, body: { plan_id }, config: cfgAsaas, db: dbReal, asaas });
const webhook = (asaas, id, event, paymentId, token = cfgAsaas.webhookToken) =>
  handleWebhook({ token, body: { id, event, payment: { id: paymentId, status: "RECEIVED", value: 0.01 } }, config: cfgAsaas, db: dbReal, asaas });
const pendentes = async (u) => (await um(`select count(*)::int n from public.payments where created_by = $1 and status = 'pending'`, [u])).n;
const vivas = (asaas) => [...asaas.cobr.values()].filter((c) => !c.deleted).length;

{
  // 1) Dois checkouts simultâneos -> uma cobrança só, no banco e no Asaas.
  const asaas = asaasFalso();
  const u = await novoFornecedor();
  const [a, b] = await Promise.all([checkout(asaas, u, "premium"), checkout(asaas, u, "premium")]);
  const st = [a.status, b.status].sort().join(",");
  ok("2 checkouts simultâneos: 1 cobrança no Asaas e 1 pendente no banco", asaas.cobr.size === 1 && (await pendentes(u.id)) === 1,
    `${st} ${a.body.error ?? ""} ${b.body.error ?? ""}`);
  // 2) Dentro da validade: o mesmo link, nada novo no Asaas.
  const c = await checkout(asaas, u, "premium");
  ok("pendente válida: reaproveita a fatura", c.status === 200 && c.body.reused === true && asaas.cobr.size === 1);

  // 3) Pago no Asaas -> webhook ativa; duplicado; outro evento "pago"; antigo fora de ordem.
  const pay = [...asaas.cobr.values()][0];
  pay.status = "RECEIVED";
  const w1 = await webhook(asaas, "evt_i1", "PAYMENT_RECEIVED", pay.id);
  const w1b = await webhook(asaas, "evt_i1", "PAYMENT_RECEIVED", pay.id);
  pay.status = "CONFIRMED";
  const w2 = await webhook(asaas, "evt_i2", "PAYMENT_CONFIRMED", pay.id);
  const w0 = await webhook(asaas, "evt_i0", "PAYMENT_CREATED", pay.id);
  const s = await um(`select count(*)::int n, min(plan_id) p from public.subscriptions where created_by = $1 and plan_id <> 'basico'`, [u.id]);
  ok("webhook: ativa uma vez; duplicado, 2º 'pago' e evento antigo não concedem de novo",
    w1.body.result === "activated" && w1b.body.result === "duplicate" && w2.body.result === "already_applied"
      && w0.body.result === "already_applied" && s.n === 1 && s.p === "premium",
    JSON.stringify([w1.body, w1b.body, w2.body, w0.body, s]));
  const semToken = await webhook(asaas, "evt_i3", "PAYMENT_RECEIVED", pay.id, "errado");
  const gravou = await um(`select count(*)::int n from public.webhook_events where event_id = 'evt_i3'`);
  ok("webhook sem token: 401 e nada gravado", semToken.status === 401 && gravou.n === 0);
}
{
  // 4) Vencida em aberto -> remove no Asaas, confere, anula, cria a nova (outro plano).
  const asaas = asaasFalso();
  const u = await novoFornecedor();
  await checkout(asaas, u, "premium");
  await db.exec(`update public.payments set due_date = current_date - 2 where created_by = '${u.id}' and status = 'pending';`);
  const r = await checkout(asaas, u, "profissional");
  const antiga = await um(`select status, closed_reason from public.payments where created_by = $1 and plan_id = 'premium'`, [u.id]);
  ok("vencida: antiga removida no Asaas e preservada no banco; nova criada",
    r.status === 200 && vivas(asaas) === 1 && asaas.cobr.size === 2 && antiga.status === "refused"
      && antiga.closed_reason === "deleted_at_gateway" && (await pendentes(u.id)) === 1,
    JSON.stringify({ r: r.body, antiga }));
}
{
  // 5) Paga no exato momento da substituição: o Asaas recusa remover.
  const asaas = asaasFalso();
  const u = await novoFornecedor();
  await checkout(asaas, u, "premium");
  await db.exec(`update public.payments set due_date = current_date - 1 where created_by = '${u.id}' and status = 'pending';`);
  asaas.pagarAoRemover = true;
  const r = await checkout(asaas, u, "premium");
  const plano = await um(`select public.fornecedor_current_plan_id($1) p`, [u.id]);
  ok("paga durante a substituição: ativa, nenhuma cobrança nova, nada perdido",
    r.body.error === "PREVIOUS_CHARGE_PAID" && asaas.cobr.size === 1 && plano.p === "premium", JSON.stringify(r.body));
}
{
  // 5b) Vencida pela VIRADA DO CICLO (covers_until no passado) e paga depois
  //     (boleto pago após o dia 10): aprovada SEM ativar, análise manual,
  //     mensagem honesta. O próximo clique hoje gera cobrança NOVA -- o
  //     cliente pode pagar duas vezes: decisão (7) pendente, só registrada.
  const asaas = asaasFalso();
  const u = await novoFornecedor();
  await checkout(asaas, u, "premium");
  await db.exec(`update public.payments set covers_until = now() - interval '1 day', due_date = current_date - 5
                 where created_by = '${u.id}' and status = 'pending';`);
  [...asaas.cobr.values()][0].status = "RECEIVED";
  const r = await checkout(asaas, u, "premium");
  const est = await um(`select public.fornecedor_current_plan_id($1) p,
      (select unapplied_reason from public.payments where created_by = $1 and status = 'approved') motivo,
      (select string_agg(reason, ',') from public.billing_reviews where created_by = $1) revisoes`, [u.id]);
  ok("vencida pelo ciclo e paga depois: não ativa, vai para análise, mensagem não promete plano",
    r.body.error === "PREVIOUS_CHARGE_UNAPPLIED" && est.p === null && est.motivo === "LATE_PAYMENT"
      && /PAYMENT_UNAPPLIED_LATE_PAYMENT/.test(est.revisoes ?? ""), JSON.stringify({ r: r.body, est }));
  // §234 (decisão 7 tomada): com o pagamento em análise, NADA de cobrança nova.
  const r2 = await checkout(asaas, u, "premium");
  ok("pagamento em análise bloqueia novo checkout (nenhuma 2ª cobrança pagável)",
    r2.status === 409 && r2.body.error === "PAYMENT_UNDER_REVIEW" && asaas.cobr.size === 1, JSON.stringify(r2.body));
  // Resolução administrativa (SQL Editor / service_role) libera.
  await db.exec(`select public.billing_review_resolve(id, 'reembolsado no painel do Asaas') from public.billing_reviews
                 where created_by = '${u.id}' and resolved_at is null;`);
  const r3 = await checkout(asaas, u, "premium");
  ok("depois da resolução, o checkout volta a funcionar", r3.status === 200 && asaas.cobr.size === 2, JSON.stringify(r3.body));
}
{
  // 5c) Evento de cobrança EXTERNA (outra loja na mesma conta Asaas, 404 ao
  //     reconsultar): ignorado, sem análise; o evento fica de auditoria.
  const asaas = asaasFalso();
  const antes = (await um(`select count(*)::int n from public.billing_reviews`)).n;
  const w = await handleWebhook({ token: cfgAsaas.webhookToken, config: cfgAsaas, db: dbReal, asaas,
    body: { id: "evt_ext", event: "PAYMENT_RECEIVED", payment: { id: "pay_de_outra_loja", externalReference: "pedido-1", customer: "cus_outra" } } });
  const ev = await um(`select status, last_error from public.webhook_events where event_id = 'evt_ext'`);
  const depois = (await um(`select count(*)::int n from public.billing_reviews`)).n;
  ok("evento externo: 200, sem análise, registrado como external_charge",
    w.status === 200 && depois === antes && ev.status === "ignored" && ev.last_error === "external_charge", JSON.stringify(ev));
}
{
  // 6) Asaas fora no webhook -> 502 e 'failed'; a reconciliação recupera, uma vez.
  const asaas = asaasFalso();
  const u = await novoFornecedor();
  await checkout(asaas, u, "profissional");
  const pay = [...asaas.cobr.values()][0];
  pay.status = "RECEIVED";
  asaas.fora = true;
  const w = await webhook(asaas, "evt_r1", "PAYMENT_RECEIVED", pay.id);
  const ev = await um(`select status from public.webhook_events where event_id = 'evt_r1'`);
  const nada = await um(`select public.fornecedor_current_plan_id($1) p`, [u.id]);
  asaas.fora = false;
  await db.exec(`update public.webhook_events set received_at = now() - interval '5 minutes' where event_id = 'evt_r1';`);
  // Duas reconciliações AO MESMO TEMPO: uma processa, a outra sai skipped.
  const RS = "r".repeat(40);
  const rodar = () => handleReconcile({ secret: RS, expectedSecret: RS, config: cfgAsaas, db: dbReal, asaas, limit: 500 });
  const [ra, rb] = await Promise.all([rodar(), rodar()]);
  const rec = ra.body.skipped ? rb : ra;
  const pulou = [ra, rb].filter((x) => x.body.skipped).length;
  const rec2 = await rodar();
  const runs = await um(`select count(*) filter (where status = 'done')::int done, count(*) filter (where status = 'running')::int running
                         from public.billing_reconcile_runs`);
  const depois = await um(`select public.fornecedor_current_plan_id($1) p,
      (select status from public.webhook_events where event_id = 'evt_r1') ev,
      (select count(*)::int from public.subscriptions where created_by = $1 and plan_id = 'profissional') n`, [u.id]);
  ok("Asaas fora: 502 + 'failed' sem ativar; reconciliação ativa uma vez e fecha o evento",
    w.status === 502 && ev.status === "failed" && nada.p === null && depois.p === "profissional"
      && depois.ev === "processed" && depois.n === 1 && rec.status === 200 && rec2.status === 200,
    JSON.stringify({ rec: rec.body, rec2: rec2.body, depois }));
  ok("reconciliações simultâneas: uma pula, nada processado duas vezes, execuções registradas",
    pulou === 1 && rec.body.processed === 1 && rec2.body.checked === 0 && runs.running === 0 && runs.done >= 2,
    JSON.stringify({ ra: ra.body, rb: rb.body, runs }));
}
{
  // 7) C1 continua fechada com tudo isso instalado.
  const u = await novoFornecedor();
  const r1 = await tentar(`${como(u.id)} select public.subscribe_to_plan('premium');`);
  const r2 = await tentar(`${como(u.id)} select public.billing_prepare_checkout('${u.id}', 'premium', 'sandbox');`);
  ok("C1: RPC pública recusa plano pago e o cliente não alcança o checkout do banco",
    /PAYMENT_REQUIRED/.test(r1) && /permission denied/.test(r2), `${r1} | ${r2}`);
}
{
  // 8) O agendamento recusa um banco com cobrança desligada (= o banco real).
  await db.exec(`update public.billing_config set accepted_environment = null;`);
  let erro = "";
  try { await db.exec(ler("billing-reconcile-cron.sql")); } catch (e) { erro = e.message; await db.exec("rollback;").catch(() => {}); }
  const job = await um(`select to_regprocedure('public.billing_reconcile_tick()') is not null as criada`);
  ok("billing-reconcile-cron.sql recusa banco com cobrança desligada e não cria nada",
    /cobrança DESLIGADA/.test(erro) && job.criada === false, erro.slice(0, 80));
  await db.exec(`update public.billing_config set accepted_environment = 'sandbox';`);
}
{
  // 9) Travas da homologação (supabase/sandbox/, §235).
  const sb = (f) => ler(`sandbox/${f}`);
  const tentarArquivo = async (sql) => {
    try { const r = await db.exec(sql); return { ok: true, rows: r.at(-1).rows }; }
    catch (e) { await db.exec("rollback;").catch(() => {}); return { ok: false, erro: e.message }; }
  };
  // 01: este banco tem usuários -> recusa (é o que protege o principal).
  let r = await tentarArquivo(sb("01-marcar-projeto-teste.sql").replace("v_ref text := '<REF-DO-TESTE>'", "v_ref text := 'abcdefghijklmnopqrst'"));
  ok("01-marcar recusa banco que já tem usuários/assinaturas", !r.ok && /já tem usuários/.test(r.erro), r.erro?.slice(0, 70));
  r = await tentarArquivo(sb("01-marcar-projeto-teste.sql"));
  ok("01-marcar recusa sem trocar o ref", !r.ok && /Troque <REF-DO-TESTE>/.test(r.erro), r.erro?.slice(0, 70));
  r = await tentarArquivo(sb("01-marcar-projeto-teste.sql").replace("v_ref text := '<REF-DO-TESTE>'", "v_ref text := 'tzbawflkcivprblqzqjk'"));
  ok("01-marcar recusa o ref do principal", !r.ok && /PRINCIPAL/.test(r.erro), r.erro?.slice(0, 70));
  // 02: sem marcador -> recusa e não liga nada.
  await db.exec(`update public.billing_config set accepted_environment = null;`);
  r = await tentarArquivo(sb("02-ligar-sandbox.sql"));
  const env1 = (await um(`select accepted_environment e from public.billing_config`)).e;
  ok("02-ligar recusa banco sem marcador (= o principal) e não liga", !r.ok && /Sem o marcador/.test(r.erro) && env1 === null, r.erro?.slice(0, 70));
  // Com marcador (simulando o projeto de teste): liga só 'sandbox'.
  await db.exec(`create schema nexar_sandbox; create table nexar_sandbox.marcador (id boolean primary key default true, project_ref text, criado_em timestamptz default now());
                 insert into nexar_sandbox.marcador (project_ref) values ('abcdefghijklmnopqrst');`);
  r = await tentarArquivo(sb("02-ligar-sandbox.sql"));
  ok("02-ligar com marcador e C1 inteira: liga sandbox", r.ok && r.rows.find((x) => x.item === "ambiente aceito")?.valor === "sandbox",
    JSON.stringify(r.rows ?? r.erro));
  // 03: verificação só leitura roda (cron simulado).
  await db.exec(`create schema if not exists cron; create table if not exists cron.job (jobname text, schedule text, command text, active boolean);`);
  r = await tentarArquivo(sb("03-verificar-projeto-teste.sql"));
  const falsos = (r.rows ?? []).filter((x) => x.ok !== true).map((x) => x.ordem);
  // 9 = trigger de cadastro em auth.users (o ensaio não carrega) e
  // 10 = extensões (o PGlite não tem pg_cron/pg_net): esperados aqui.
  ok("03-verificar roda; no PGlite só falham o trigger de auth e as extensões",
    r.ok && falsos.join(",") === "9,10", JSON.stringify(falsos));
  // pós-importação: com marcador, religa os padrões sem erro.
  r = await tentarArquivo(sb("pos-importacao-teste.sql"));
  ok("pos-importacao com marcador: religa os privilégios padrão", r.ok, r.erro?.slice(0, 80));
  await db.exec(`drop schema nexar_sandbox cascade;`);
  r = await tentarArquivo(sb("pos-importacao-teste.sql"));
  ok("pos-importacao recusa sem marcador", !r.ok && /Sem o marcador/.test(r.erro), r.erro?.slice(0, 70));
  // pré-importação: este banco já tem o esquema do NEXAR (= o principal) -> recusa.
  const aclAntes = JSON.stringify((await db.query(ler("sandbox/acl-public.sql"))).rows);
  r = await tentarArquivo(sb("pre-importacao-teste.sql"));
  const aclDepois = JSON.stringify((await db.query(ler("sandbox/acl-public.sql"))).rows);
  ok("pre-importacao recusa banco com o esquema do NEXAR e não mexe em permissão nenhuma",
    !r.ok && /já tem o esquema/.test(r.erro) && aclAntes === aclDepois, r.erro?.slice(0, 70));
  ok("acl-public.sql roda e lista funções/tabelas/RLS", aclAntes.includes('"tipo":"funcao"') && aclAntes.includes('"tipo":"rls"'));
}
{
  // 10) A tese do pre-importacao, no PGlite: com privilégio padrão LIGADO,
  //     uma função recriada a partir de um dump (REVOKE FROM PUBLIC + GRANT só
  //     a authenticated) continua executável por anon; com o padrão
  //     DESLIGADO, sai igual à origem.
  const dump = (n) => `create function public.${n}() returns int language sql as 'select 1';
    revoke all on function public.${n}() from public; grant all on function public.${n}() to authenticated;`;
  await db.exec(`alter default privileges for role postgres in schema public grant execute on functions to anon;`);
  await db.exec(dump("_acl_com_padrao"));
  await db.exec(`alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;`);
  await db.exec(dump("_acl_sem_padrao"));
  const a = await um(`select has_function_privilege('anon', 'public._acl_com_padrao()', 'execute') com,
                             has_function_privilege('anon', 'public._acl_sem_padrao()', 'execute') sem`);
  ok("importar com o padrão ligado reabre permissão revogada (anon executa); sem o padrão, não",
    a.com === true && a.sem === false, JSON.stringify(a));
  await db.exec(`drop function public._acl_com_padrao(); drop function public._acl_sem_padrao();
                 alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;`);
}

console.log(`\n${falhas === 0 ? "TUDO OK" : falhas + " FALHA(S)"}`);
process.exit(falhas === 0 ? 0 : 1);
