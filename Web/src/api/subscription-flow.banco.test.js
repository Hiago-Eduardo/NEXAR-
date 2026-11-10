/**
 * TESTES DE FLUXO DA ASSINATURA -- contra o banco de verdade.
 *
 * POR QUE ESTE ARQUIVO EXISTE, e é a lacuna que ele fecha: o ciclo do dia 10
 * (seções 121-128) foi provado rodando scripts de uma vez só, que eu apaguei
 * depois. A matriz em plans.test.js cobre o ESPELHO no client -- o que a
 * interface acha que vai acontecer -- e nada cobria o que o banco REALMENTE
 * faz. Mexer no subscribe_to_plan amanhã não quebraria teste nenhum.
 *
 * ---------------------------------------------------------------------------
 * NÃO RODAM NO `npm test` (seção 168). Rodam só com `npm run test:banco`.
 * Até a seção 168 rodavam em todo `npm test`, e cada rodada deixava 3
 * notificações ("Troca de plano confirmada", "Cancelamento agendado",
 * "Cancelamento desfeito") na conta -- que era a MESMA conta de fornecedor
 * usada para testar o site à mão. Chegou a 118 notificações. O `npm test`
 * é rodado como validação a cada mudança; ele tem de ser inofensivo.
 * O sufixo .banco.test.js é o que o separa: o script "test" exclui esse
 * padrão.
 *
 * ESTES TESTES ESCREVEM. É a exceção à regra da suíte (ler, não escrever),
 * e o portão é explícito: eles só rodam contra a conta nomeada em
 * TEST_ASSINATURA_EMAIL no .env.local. Sem essa variável, tudo pula.
 *
 * Nomear a conta -- em vez de um TEST_ALLOW_WRITES=1 genérico -- é o portão
 * de propósito: obriga quem liga os testes a declarar QUAL conta pode ser
 * sacrificada, e torna impossível apontá-los para uma conta real por engano.
 * Também resolve o problema de `VAR=1 npm test` não funcionar no PowerShell.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getPlanAdLimit, getPlanProductLimit } from '../lib/plans';

function lerEnvLocal() {
  const arquivo = path.resolve(process.cwd(), '.env.local');
  const out = {};
  if (!fs.existsSync(arquivo)) return out;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = lerEnvLocal();
const ligado = !!(env.TEST_ASSINATURA_EMAIL && env.TEST_ASSINATURA_PASSWORD
  && env.VITE_SUPABASE_URL && env.VITE_SUPABASE_PUBLISHABLE_KEY);
const suite = ligado ? describe : describe.skip;

const novoClient = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);

// O PostgREST devolve um composite de colunas nulas, não null, quando a
// função não acha linha -- ver rowOrNull em client.js e a seção 119.
const vazio = (r) => !r || r.id == null;

let sb;
let uid;

async function atual() {
  const { data } = await sb.rpc('my_current_subscription');
  return vazio(data) ? null : data;
}
async function agendada() {
  const { data } = await sb.rpc('my_scheduled_subscription');
  return vazio(data) ? null : data;
}
async function eventos() {
  const { data } = await sb.from('subscription_events').select('*')
    .eq('created_by', uid).order('created_at', { ascending: true });
  return data || [];
}
async function notificacoes() {
  const { data } = await sb.from('notifications').select('*')
    .eq('created_by', uid).order('created_at', { ascending: true });
  return data || [];
}
async function meusAnuncios() {
  const { data } = await sb.from('suppliers')
    .select('id,business_name,status,status_before_suspension,suspended_at,suspension_reason,created_at')
    .eq('created_by', uid);
  return data || [];
}
async function meusProdutos() {
  const { data } = await sb.from('products')
    .select('id,name,status,suspension_reason,created_at')
    .eq('created_by', uid);
  return data || [];
}

// O estado que apply_plan_limits garante (plan-limits-central.sql), para
// anúncios OU produtos de uma conta com plano `planId` (null = sem plano):
//  * ativos <= limite;
//  * havendo suspenso por limite, os ativos ENCHEM o limite (não sobra vaga
//    com item esperando);
//  * motivo = causa atual: sem plano só no_plan, com plano só plan_limit.
function conferirEstado(itens, limite, planId) {
  const ativos = itens.filter((i) => (i.status || 'active') === 'active').length;
  const porLimite = itens.filter((i) => i.status === 'suspended' && i.suspension_reason === 'plan_limit').length;
  const semPlano = itens.filter((i) => i.status === 'suspended' && i.suspension_reason !== 'plan_limit').length;
  expect(ativos).toBeLessThanOrEqual(limite);
  if (porLimite > 0) expect(ativos).toBe(limite);
  if (planId) expect(semPlano).toBe(0);
  else expect(porLimite).toBe(0);
}

const diaDoMes = (iso) =>
  Number(new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit' }));

suite('fluxo da assinatura (escreve -- conta de TEST_ASSINATURA_EMAIL)', () => {
  beforeAll(async () => {
    sb = novoClient();
    const { data, error } = await sb.auth.signInWithPassword({
      email: env.TEST_ASSINATURA_EMAIL,
      password: env.TEST_ASSINATURA_PASSWORD,
    });
    if (error) throw new Error(`login falhou para ${env.TEST_ASSINATURA_EMAIL}: ${error.message}`);
    uid = data.user.id;
  });

  // ------------------------------------------------------------------ dia 10
  it('next_billing_date cai sempre num dia 10', async (ctx) => {
    const { data, error } = await sb.rpc('next_billing_date');
    expect(error).toBeNull();
    expect(diaDoMes(data)).toBe(10);
    // Estritamente no futuro: a cobrança de hoje é a que está acontecendo.
    expect(new Date(data).getTime()).toBeGreaterThan(Date.now());
  });

  // --------------------------------------------------------------- downgrade
  // ------------------------------------------- C1 (Resumo.md seção 231)
  // Desde fix-paid-plan-activation.sql, subscribe_to_plan só aceita o
  // Básico: plano pago (novo, upgrade ou troca agendada para outro pago)
  // responde PAYMENT_REQUIRED e NADA muda na conta.
  it('C1: plano pago pela RPC é recusado e nada muda', async () => {
    const antes = await atual();
    const agAntes = await agendada();
    for (const p of ['premium', 'profissional']) {
      if (antes?.plan_id === p) continue;
      const { error } = await sb.rpc('subscribe_to_plan', { p_plan_id: p });
      expect(error?.message || '').toMatch(/PAYMENT_REQUIRED/);
    }
    expect(await atual()).toEqual(antes);
    expect(await agendada()).toEqual(agAntes);
  });

  it('DOWNGRADE agenda sem tocar no plano vigente', async (ctx) => {
    const antes = await atual();
    if (!antes || antes.plan_id !== 'premium') {
      // Não força o estado: um teste que reescreve a conta para poder rodar
      // esconde justamente o caso em que ela está diferente do esperado.
      // E o pulo é VISÍVEL (ctx.skip), não um expect(true) disfarçado de
      // aprovação -- foi assim que quatro sondas mentiram nesta sessão.
      return ctx.skip();
    }

    // Premium -> Profissional (pago -> pago) virou PAYMENT_REQUIRED (C1);
    // o downgrade que continua existindo é para o Básico.
    const { error } = await sb.rpc('subscribe_to_plan', { p_plan_id: 'basico' });
    expect(error).toBeNull();

    const depois = await atual();
    const sched = await agendada();

    // O plano atual tem que estar INTACTO -- a spec §7 proíbe retirar
    // recurso antes da data.
    expect(depois.id).toBe(antes.id);
    expect(depois.status).toBe('active');
    expect(depois.expires_at).toBe(antes.expires_at);

    // A emenda é exata: a agendada começa quando a atual termina.
    expect(sched).not.toBeNull();
    expect(sched.plan_id).toBe('basico');
    expect(sched.started_at).toBe(antes.expires_at);
    // Básico é gratuito e sem vencimento.
    expect(String(sched.expires_at)).toMatch(/infinity/i);
    expect(sched.next_charge_at).toBeNull();
  });

  it('o downgrade virou auditoria E notificação', async (ctx) => {
    if (!(await agendada())) return ctx.skip();
    const ev = await eventos();
    const nt = await notificacoes();
    expect(ev.some((e) => e.event_type === 'plan_change_scheduled')).toBe(true);
    expect(nt.some((n) => n.type === 'plan_change_scheduled')).toBe(true);
  });

  it('DESFAZER a troca apaga o agendamento e não mexe no plano', async (ctx) => {
    if (!(await agendada())) return ctx.skip();
    const antes = await atual();

    const { error } = await sb.rpc('cancel_scheduled_plan_change');
    expect(error).toBeNull();

    expect(await agendada()).toBeNull();
    const depois = await atual();
    expect(depois.id).toBe(antes.id);
    expect(depois.status).toBe('active');
  });

  // ------------------------------------------------------ cancelar/reativar
  it('CANCELAR preserva o acesso e zera a cobrança', async (ctx) => {
    const antes = await atual();
    if (!antes || antes.status !== 'active' || antes.plan_id === 'basico') {
      return ctx.skip();
    }

    const { error } = await sb.rpc('cancel_my_subscription');
    expect(error).toBeNull();

    const depois = await atual();
    expect(depois.status).toBe('cancelled');
    // Acesso até o fim do período JÁ PAGO -- expires_at não é reescrito.
    expect(depois.expires_at).toBe(antes.expires_at);
    // E a cobrança some: é a linha que diz ao gateway "não cobre mais".
    expect(depois.next_charge_at).toBeNull();
  });

  it('REATIVAR devolve o plano E a cobrança', async (ctx) => {
    const antes = await atual();
    if (!antes || antes.status !== 'cancelled') return ctx.skip();

    const { error } = await sb.rpc('reactivate_my_subscription');
    expect(error).toBeNull();

    const depois = await atual();
    expect(depois.status).toBe('active');
    // Sem esta linha o fornecedor voltaria ao plano sem nada a cobrar.
    expect(depois.next_charge_at).toBe(depois.expires_at);
  });

  it('cancelar e reativar viraram auditoria E notificação', async (ctx) => {
    const ev = await eventos();
    const nt = await notificacoes();
    expect(ev.some((e) => e.event_type === 'subscription_cancelled')).toBe(true);
    expect(ev.some((e) => e.event_type === 'subscription_reactivated')).toBe(true);
    expect(nt.some((n) => n.type === 'subscription_cancelled')).toBe(true);
    expect(nt.some((n) => n.type === 'subscription_reactivated')).toBe(true);
  });

  // -------------------------------------------------------------- proteções
  it('recusa assinar o plano que já é o atual', async (ctx) => {
    const cur = await atual();
    if (!cur) return ctx.skip();
    const { error } = await sb.rpc('subscribe_to_plan', { p_plan_id: cur.plan_id });
    // Plano pago cai antes na guarda C1 (PAYMENT_REQUIRED); o Básico, aqui.
    expect(error?.message || '').toMatch(cur.plan_id === 'basico' ? /ALREADY_ON_PLAN/ : /PAYMENT_REQUIRED/);
  });

  it('recusa um plano que não existe', async (ctx) => {
    const { error } = await sb.rpc('subscribe_to_plan', { p_plan_id: 'ouro' });
    expect(error?.message || '').toMatch(/INVALID_PLAN/);
  });

  it('o client NÃO consegue escrever em subscriptions direto', async (ctx) => {
    // A garantia de que datas e status só nascem das RPCs: não há policy de
    // insert/update/delete na tabela. Se este teste passar a falhar, alguém
    // afrouxou a RLS e o client virou capaz de forjar vigência.
    const { error } = await sb.from('subscriptions').insert({
      created_by: uid, plan_id: 'premium', status: 'active',
      started_at: new Date().toISOString(), expires_at: '2099-01-01',
    });
    expect(error).not.toBeNull();
  });

  // ------------------------------------------------------------- suspensão
  // Desde plan-limits-central.sql (seção 185) quem suspende e restaura é só
  // a função central do banco. As RPCs antigas viraram internas.
  it('suspend_my_ads / restore_my_suspended_ads NÃO estão ao alcance do fornecedor', async () => {
    for (const fn of ['suspend_my_ads', 'restore_my_suspended_ads', 'apply_plan_limits', 'run_plan_maintenance']) {
      const { error } = await sb.rpc(fn, fn === 'apply_plan_limits' ? { p_uid: uid } : {});
      expect(error, fn).not.toBeNull();
    }
  });

  it('o fornecedor não suspende nem tira da suspensão pela API', async (ctx) => {
    const anuncios = await meusAnuncios();
    const ativo = anuncios.find((a) => (a.status || 'active') === 'active');
    if (!ativo) return ctx.skip();
    const { error } = await sb.from('suppliers').update({ status: 'suspended' }).eq('id', ativo.id);
    expect(error?.message || '').toMatch(/SYSTEM_STATUS/);
  });

  it('sync deixa anúncios e produtos dentro do limite, com o motivo certo', async () => {
    const { error } = await sb.rpc('sync_my_subscription');
    expect(error).toBeNull();
    const cur = await atual();
    const planId = cur && ['active', 'cancelled'].includes(cur.status) ? cur.plan_id : null;
    conferirEstado(await meusAnuncios(), getPlanAdLimit(planId), planId);
    conferirEstado(await meusProdutos(), getPlanProductLimit(planId), planId);
  });

  it('sync é idempotente: rodar de novo não muda nada', async () => {
    await sb.rpc('sync_my_subscription');
    const antes = JSON.stringify((await meusAnuncios()).map((a) => [a.id, a.status, a.suspension_reason]).sort());
    const { error } = await sb.rpc('sync_my_subscription');
    expect(error).toBeNull();
    const depois = JSON.stringify((await meusAnuncios()).map((a) => [a.id, a.status, a.suspension_reason]).sort());
    expect(depois).toBe(antes);
  });

  // ----------------------------------------------------------- concorrência
  it('duas syncs SIMULTÂNEAS terminam sem erro e no mesmo estado válido', async () => {
    const [a, b] = await Promise.all([sb.rpc('sync_my_subscription'), sb.rpc('sync_my_subscription')]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const cur = await atual();
    const planId = cur && ['active', 'cancelled'].includes(cur.status) ? cur.plan_id : null;
    conferirEstado(await meusAnuncios(), getPlanAdLimit(planId), planId);
  });

  it('duas ativações SIMULTÂNEAS não passam do limite de anúncios', async (ctx) => {
    const cur = await atual();
    const planId = cur && ['active', 'cancelled'].includes(cur.status) ? cur.plan_id : null;
    const limite = getPlanAdLimit(planId);
    const anuncios = await meusAnuncios();
    const ativos = anuncios.filter((a) => (a.status || 'active') === 'active');
    const pausados = anuncios.filter((a) => a.status === 'paused');
    // Precisa de exatamente UMA vaga e dois pausados para a corrida valer.
    if (!planId || limite === Infinity || limite - ativos.length !== 1 || pausados.length < 2) return ctx.skip();

    const [r1, r2] = await Promise.all(pausados.slice(0, 2).map((a) =>
      sb.from('suppliers').update({ status: 'active' }).eq('id', a.id).select('id')));
    const passaram = [r1, r2].filter((r) => !r.error);
    expect(passaram.length).toBe(1);
    expect([r1, r2].find((r) => r.error)?.error.message || '').toMatch(/PLAN_LIMIT/);

    // devolve a conta como estava
    for (const r of passaram) await sb.from('suppliers').update({ status: 'paused' }).eq('id', r.data[0].id);
  });
});
