// Ensaio LOCAL de supabase/fix-paid-plan-activation.sql (Resumo.md seção 231).
//
// NADA toca o Supabase real: roda num Postgres em memória (PGlite).
// O banco é montado com as funções, triggers e grants REAIS lidos dos
// arquivos supabase/*.sql na ordem em que foram aplicados (não redigitados),
// mais um esquema mínimo das tabelas (o DDL de subscriptions/suppliers não
// está no repo; plan_id fica SEM NOT NULL -- o pior caso) e os privilégios
// padrão do Supabase (anon/authenticated com ALL nas tabelas; RLS protege).
//
// Passos: 1) prova a falha no corpo atual; 2) roda a migração (os testes
// T1-T10/P1-P6 embutidos nela); 3) roda de novo (re-executável); 4) cenários
// extras com anúncios/produtos/limites/manutenção; 5) assinaturas pré-
// existentes intactas.
//
// Uso (PGlite não é dependência do projeto):
//   npm i --no-save @electric-sql/pglite@0.2.17      (ou numa pasta à parte)
//   node scripts/ensaio-fix-paid-plan-activation.mjs
//   PGLITE=/caminho/node_modules/@electric-sql/pglite/dist/index.js node scripts/...
import { montarBanco } from "./lib/pglite-nexar.mjs";

const { db, ler, blocosDeFuncao, conta, como, tentar, um } = await montarBanco();
let falhas = 0;
const ok = (nome, cond, extra = "") => {
  if (!cond) falhas++;
  console.log(`${cond ? "ok  " : "FALHOU"}  ${nome}${extra ? "  -- " + extra : ""}`);
};

// Os arquivos do repo já trazem a guarda C1 em todos os subscribe_to_plan
// (§232). Para provar que a migração ainda corrige o banco que estava NO AR
// antes dela, recria o corpo vulnerável: o da central SEM a guarda.
{
  const central = blocosDeFuncao(ler("plan-limits-central.sql")).find((b) => /function public\.subscribe_to_plan\(/.test(b));
  const vulneravel = central.replace(/  -- C1 \(Resumo\.md §231-232\)[\s\S]*?PAYMENT_REQUIRED[\s\S]*?end if;\n/, "");
  if (vulneravel === central) throw new Error("não achei a guarda C1 na central para remover");
  await db.exec(vulneravel);
}
// ---------------------------------------------- 1) a falha, ANTES da correção
console.log('\n== 1) corpo atual (plan-limits-central.sql) -- a falha');
{
  const u = await conta('cliente');
  await db.exec('begin;');
  const r = await tentar(`${como(u)} select public.subscribe_to_plan('premium');`);
  const s = await um(`select plan_id, status from public.subscriptions where created_by = $1`, [u]);
  ok('ANTES: conta cliente ganha Premium só chamando a RPC (falha reproduzida)', r === 'ok' && s?.plan_id === 'premium', JSON.stringify(s));
  await db.exec('rollback;');

  const v = await conta();
  await db.exec(`begin; insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
                 values ('${v}', 'premium', 'active', now() - interval '1 day', public.next_billing_date(now()));`);
  await tentar(`${como(v)} select public.subscribe_to_plan('profissional');`);
  const g = await um(`select plan_id, status, expires_at > started_at as ciclo from public.subscriptions where created_by = $1 and status = 'scheduled'`, [v]);
  ok('ANTES: Premium -> Profissional agenda um ciclo pago de graça (caminho c)', g?.plan_id === 'profissional', JSON.stringify(g));
  await db.exec('rollback;');
}

// ------------------- assinaturas existentes (para provar que ficam intactas)
const legado = [];
for (const [plano, status, ini, fim] of [
  ['premium', 'active', "now() - interval '5 days'", 'public.next_billing_date(now())'],
  ['profissional', 'cancelled', "now() - interval '5 days'", 'public.next_billing_date(now())'],
  ['basico', 'active', "now() - interval '40 days'", "'infinity'"],
  ['premium', 'expired', "now() - interval '60 days'", "now() - interval '20 days'"],
]) {
  const u = await conta();
  legado.push(u);
  await db.exec(`insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
                 values ('${u}', '${plano}', '${status}', ${ini}, ${fim});`);
}
// um downgrade pago->pago feito ANTES da correção (fica, por decisão do usuário)
await db.exec(`insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
               select '${legado[0]}', 'profissional', 'scheduled', expires_at, public.next_billing_date(expires_at)
               from public.subscriptions where created_by = '${legado[0]}';`);
const hashSubs = async () => (await um(
  `select md5(string_agg(to_jsonb(s)::text, '|' order by id)) h from public.subscriptions s where created_by = any($1::uuid[])`,
  [legado])).h;
const hAntes = await hashSubs();

// ---------------------------------------------------------- 2) a migração
const migracao = ler('fix-paid-plan-activation.sql');
for (const rodada of [1, 2]) {
  console.log(`\n== ${rodada + 1}) fix-paid-plan-activation.sql -- ${rodada === 1 ? 'primeira execução (arquivo inteiro)' : 'reexecução (DO e select em chamadas separadas)'}`);
  let res;
  try {
    if (rodada === 1) {
      res = await db.exec(migracao);
    } else {
      // Como um editor que roda cada comando à parte (a falha 42P01 de
      // 2026-11-03): o DO sozinho, depois notify + select noutra chamada.
      const corte = migracao.indexOf("$mig$;") + "$mig$;".length;
      await db.exec(migracao.slice(0, corte));
      res = await db.exec(migracao.slice(corte));
    }
  } catch (e) {
    ok(`migração rodou (${rodada})`, false, e.message);
    await db.exec('rollback;').catch(() => {});
    break;
  }
  // O DO só termina sem erro se todos os testes passaram; o select final
  // confere o estado. 20 = T1..T10 (11 linhas) + P1..P6 + P7 x3.
  const v = Object.fromEntries(res.at(-1).rows.map((l) => [l.ordem, l.valor]));
  ok(`testes embutidos (${v[1]})`, v[1] === '20/20 testes ok');
  ok('guarda no corpo vivo', v[2] === 'true', v[2]);
  ok('subscribe_to_plan: anon / authenticated', v[3] === 'false / true', v[3]);
  ok('escrita do cliente nas tabelas financeiras', v[4] === 'nenhuma', v[4]);
  ok('anon nas 3 RPCs de leitura/desfazer', v[5] === 'false / false / false', v[5]);
}

// --------------------------------------------------- 4) cenários extras
console.log('\n== 4) depois: anúncios, produtos, limites, manutenção, UI de prévia');
{
  // Básico pelo cliente + limite de anúncios pelo trigger real
  const u = await conta();
  let r = await tentar(`${como(u)} insert into public.suppliers (created_by, name) values ('${u}', 'sem plano');`);
  ok('sem plano: criar anúncio ativo é recusado (PLAN_REQUIRED)', /PLAN_REQUIRED/.test(r), r);
  r = await tentar(`${como(u)} select public.subscribe_to_plan('basico');`);
  ok('assina o Básico como o fornecedor', r === 'ok', r);
  r = await tentar(`${como(u)} insert into public.suppliers (created_by, name) values ('${u}', 'a1');`);
  ok('Básico: 1º anúncio ativo entra', r === 'ok', r);
  r = await tentar(`${como(u)} insert into public.suppliers (created_by, name) values ('${u}', 'a2');`);
  ok('Básico: 2º anúncio ativo é recusado (PLAN_LIMIT)', /PLAN_LIMIT/.test(r), r);
  r = await tentar(`${como(u)} update public.suppliers set verified = true where created_by = '${u}';`);
  ok('cliente não liga o selo verificado direto', r !== 'ok', r);
  r = await tentar(`${como(u)} select public.subscribe_to_plan('premium');`);
  ok('Básico -> Premium recusado', r === 'PAYMENT_REQUIRED', r);
  const plano = await um(`select public.fornecedor_current_plan_id($1) p`, [u]);
  ok('continua no Básico', plano.p === 'basico');
  r = await tentar(`${como(u)} select public.preview_my_plan_change('premium');`);
  ok('prévia da troca (preview_my_plan_change) segue respondendo', r === 'ok', r);
  r = await tentar(`${como(u)} select public.cancel_my_subscription();`);
  const sup = await um(`select count(*) filter (where status='suspended' and suspension_reason='no_plan')::int n from public.suppliers where created_by = $1`, [u]);
  ok('cancelar o Básico: anúncio suspenso (no_plan) pela central', r === 'ok' && sup.n === 1, `${r} ${JSON.stringify(sup)}`);
}
{
  // Conta paga LEGÍTIMA (gravada pelo sistema) com 3 anúncios; agenda
  // Básico; a virada pelo agendador suspende o excedente.
  const u = await conta();
  await db.exec(`insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
                 values ('${u}', 'premium', 'active', now() - interval '20 days', public.next_billing_date(now()));
                 insert into public.suppliers (created_by, name, created_at) values
                   ('${u}', 'p1', now() - interval '3 days'), ('${u}', 'p2', now() - interval '2 days'), ('${u}', 'p3', now() - interval '1 day');
                 insert into public.products (created_by, name) select '${u}', 'prod' || g from generate_series(1, 7) g;`);
  let r = await tentar(`${como(u)} insert into public.suppliers (created_by, name) values ('${u}', 'p4');`);
  ok('Premium existente: segue criando anúncio (ilimitado)', r === 'ok', r);
  r = await tentar(`${como(u)} select public.subscribe_to_plan('basico');`);
  ok('Premium -> Básico agenda a troca', r === 'ok', r);
  r = await tentar(`${como(u)} select public.subscribe_to_plan('profissional');`);
  ok('Premium -> Profissional recusado', r === 'PAYMENT_REQUIRED', r);
  await db.exec(`update public.subscriptions set expires_at = now() - interval '1 second' where created_by = '${u}' and status = 'active';
                 update public.subscriptions set started_at = now() - interval '1 second' where created_by = '${u}' and status = 'scheduled';`);
  const m = await um(`select public.run_plan_maintenance() j`);
  const s = await um(`select public.fornecedor_current_plan_id($1) p,
      (select count(*) from public.suppliers where created_by = $1 and status = 'active')::int ativos,
      (select count(*) from public.suppliers where created_by = $1 and suspension_reason = 'plan_limit')::int susp,
      (select count(*) from public.products where created_by = $1 and status = 'active')::int prod
    `, [u]);
  ok('manutenção (run_plan_maintenance): virada para o Básico, 1 ativo, 3 plan_limit, 5 produtos',
    s.p === 'basico' && s.ativos === 1 && s.susp === 3 && s.prod === 5 && m.j.failed === 0, JSON.stringify({ ...s, m: m.j }));
  const ev = await um(`select count(*)::int n from public.notifications where created_by = $1`, [u]);
  ok('notificações continuam sendo geradas', ev.n > 0, `${ev.n}`);
}
{
  const r = await tentar(`select set_config('request.jwt.claims', '{"role":"anon"}', false); set role anon; select public.subscribe_to_plan('basico');`);
  ok('anon não executa subscribe_to_plan', /permission denied/.test(r), r);
}

// ------------------------------- 5) assinaturas que já existiam: intactas
const hDepois = await hashSubs();
ok('assinaturas pré-existentes (incl. o agendamento pago antigo) intactas', hAntes === hDepois, `${hAntes?.slice(0, 8)} / ${hDepois?.slice(0, 8)}`);

// ---------------- 6) prova negativa: corpo antigo vivo -> a migração recusa
console.log('\n== 6) alguém re-rodou billing-cycle-day-10.sql: a migração tem de abortar');
{
  const antigo = blocosDeFuncao(ler('billing-cycle-day-10.sql')).find((b) => /function public\.subscribe_to_plan\(/.test(b));
  await db.exec(antigo);
  const h1 = await hashSubs();
  const antes = await um(`select prosrc from pg_proc where proname = 'subscribe_to_plan'`);
  let erro = '';
  try { await db.exec(migracao); } catch (e) { erro = e.message; await db.exec('rollback;').catch(() => {}); }
  ok('pré-verificação recusa corpo desconhecido', /PRECHECK: o corpo vivo/.test(erro), erro.slice(0, 90));
  const src = await um(`select prosrc from pg_proc where proname = 'subscribe_to_plan'`);
  // O corpo de billing-cycle-day-10.sql também tem a guarda desde §232; o
  // que se prova é que a migração não o trocou.
  ok('...e não trocou nada', src.prosrc === antes.prosrc && h1 === (await hashSubs()));
}

// ---------------- 7) o diagnóstico só-leitura roda e não escreve nada
console.log('\n== 7) fix-paid-plan-activation-diagnostico.sql');
{
  await db.exec(`create schema if not exists cron;
    create table if not exists cron.job (jobname text, schedule text, command text, active boolean);
    insert into cron.job values ('nexar-plan-maintenance', '*/10 * * * *', 'call public.run_plan_maintenance_job()', true);`);
  const h1 = await hashSubs();
  let linhas = [];
  try { linhas = (await db.exec(ler('fix-paid-plan-activation-diagnostico.sql'))).at(-1).rows; } catch (e) { ok('diagnóstico roda', false, e.message); }
  const secoes = new Set(linhas.map((l) => l.secao.split(' ')[0]));
  ok('diagnóstico roda e cobre as seções 1-10', ['1', '2', '4', '5', '6', '7', '8', '9', '10'].every((s) => secoes.has(s)), [...secoes].join(','));
  const sub = linhas.find((l) => l.secao === '1 funcao' && l.item === 'subscribe_to_plan(text)');
  ok('diagnóstico: subscribe_to_plan sem PUBLIC/anon, com authenticated', /anon=f authenticated=t public=f/.test(sub?.valor || ''), sub?.valor);
  ok('diagnóstico não escreveu', h1 === (await hashSubs()));

  // Num banco SEM o esquema do NEXAR (o projeto de teste ainda vazio), a
  // trava para com mensagem clara em vez de "relation does not exist".
  const { PGlite } = await import(process.env.PGLITE ? (await import('node:url')).pathToFileURL(process.env.PGLITE).href : '@electric-sql/pglite');
  const vazio = new PGlite();
  let erro = '';
  try { await vazio.exec(ler('fix-paid-plan-activation-diagnostico.sql')); } catch (e) { erro = e.message; }
  ok('diagnóstico num banco vazio: "PROJETO ERRADO" com o ref do principal', /PROJETO ERRADO.*tzbawflkcivprblqzqjk/.test(erro), erro.slice(0, 90));
  await vazio.close();
}

// ---------------- 8) prova negativa: teste reprovado -> nada é aplicado
console.log('\n== 8) um teste reprovado tem de desfazer a migração inteira');
{
  const central = blocosDeFuncao(ler('plan-limits-central.sql')).find((b) => /function public\.subscribe_to_plan\(/.test(b));
  // O corpo vulnerável (central sem a guarda), como no início do ensaio.
  await db.exec(central.replace(/  -- C1 \(Resumo\.md §231-232\)[\s\S]*?PAYMENT_REQUIRED[\s\S]*?end if;\n/, ''));
  await db.exec('grant execute on function public.cancel_scheduled_plan_change() to anon;');
  const sabotada = migracao.replace("'basico/active/true/plano_vigente=basico'", "'SABOTADO'");
  let erro = '';
  try { await db.exec(sabotada); } catch (e) { erro = e.message; await db.exec('rollback;').catch(() => {}); }
  ok('teste reprovado aborta', /ABORTADO: teste\(s\) falharam/.test(erro) && /T1 sem plano/.test(erro), erro.slice(0, 80));
  const src = await um(`select prosrc from pg_proc where proname = 'subscribe_to_plan'`);
  const anon = await um(`select has_function_privilege('anon', 'public.cancel_scheduled_plan_change()', 'execute') a`);
  ok('...e nada ficou: corpo sem a guarda, grants intactos', !src.prosrc.includes('PAYMENT_REQUIRED') && anon.a === true);
}

console.log(`\n${falhas === 0 ? 'TUDO OK' : falhas + ' FALHA(S)'}`);
process.exit(falhas === 0 ? 0 : 1);
