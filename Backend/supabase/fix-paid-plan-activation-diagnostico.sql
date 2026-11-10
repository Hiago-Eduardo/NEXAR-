-- ==========================================================================
-- C1 -- DIAGNÓSTICO SÓ LEITURA (Resumo.md seção 231)
--
-- Rodar ANTES de fix-paid-plan-activation.sql e colar o resultado de volta.
-- Só leitura: nenhum BEGIN, nenhuma escrita, nenhuma função criada. O único
-- DO (seção 0) só confere o projeto e para com erro se for o banco errado.
-- Confirma no banco vivo o que a migração supõe (assinaturas das funções,
-- dono, definer/invoker, search_path, EXECUTE, sobrecargas, RLS, policies,
-- privilégios de escrita) e mostra o que está em jogo no próximo dia 10.
-- Uma linha por item; coluna `valor` em texto (booleanos saem como t/f).
-- ==========================================================================

-- 0) Trava de leitura (só levanta erro, não grava nada): sem o esquema do
--    NEXAR, você está no projeto ERRADO -- em geral o de teste ainda vazio
--    (nshycknkefgmqnelybyu). Este diagnóstico é do PRINCIPAL
--    (tzbawflkcivprblqzqjk): a URL do SQL Editor tem de conter esse ref.
do $trava$
begin
  if to_regclass('public.subscriptions') is null then
    raise exception 'PROJETO ERRADO: este banco não tem o esquema do NEXAR (public.subscriptions não existe). Rode este diagnóstico no projeto PRINCIPAL tzbawflkcivprblqzqjk.';
  end if;
end
$trava$;

-- 1) RPCs de assinatura (e as internas que elas chamam)
select '1 funcao' as secao,
       p.oid::regprocedure::text as item,
       format('dono=%s definer=%s config=%s anon=%s authenticated=%s public=%s corpo_central=%s ja_corrigido=%s',
              pg_get_userbyid(p.proowner), p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '-'),
              has_function_privilege('anon', p.oid, 'execute'),
              has_function_privilege('authenticated', p.oid, 'execute'),
              p.proacl is null
                or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
              position('subscribe_to_plan:new' in p.prosrc) > 0,
              position('PAYMENT_REQUIRED' in p.prosrc) > 0) as valor
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('subscribe_to_plan', 'cancel_my_subscription', 'reactivate_my_subscription',
                    'sync_my_subscription', 'cancel_scheduled_plan_change', 'my_current_subscription',
                    'my_scheduled_subscription', 'advance_subscription_state', 'sync_subscription_for',
                    'apply_plan_limits', 'apply_plan_limits_safe', 'run_plan_maintenance',
                    'fornecedor_current_plan_id', 'preview_my_plan_change', 'swap_plan_slot')

union all
-- 2) Sobrecargas (esperado: nenhuma linha com n > 1)
select '2 sobrecargas', proname, count(*)::text
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('subscribe_to_plan', 'cancel_my_subscription', 'reactivate_my_subscription',
                  'sync_my_subscription', 'cancel_scheduled_plan_change')
group by proname

union all
-- 3) Outras funções chamáveis pelo cliente que gravam em assinatura/pagamento
select '3 outra funcao que grava', p.oid::regprocedure::text,
       format('anon=%s authenticated=%s',
              has_function_privilege('anon', p.oid, 'execute'),
              has_function_privilege('authenticated', p.oid, 'execute'))
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.prorettype <> 'trigger'::regtype
  and p.prokind = 'f'
  and (has_function_privilege('authenticated', p.oid, 'execute')
       or has_function_privilege('anon', p.oid, 'execute'))
  and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(subscriptions|payments|payment_attempts)\M'
  and p.proname not in ('subscribe_to_plan', 'cancel_my_subscription', 'reactivate_my_subscription',
                        'cancel_scheduled_plan_change')

union all
-- 4) RLS das tabelas financeiras
select '4 rls', c.relname, format('rls=%s force=%s', c.relrowsecurity, c.relforcerowsecurity)
from pg_class c
where c.oid in (to_regclass('public.subscriptions'), to_regclass('public.payments'),
                to_regclass('public.payment_attempts'), to_regclass('public.payment_methods'),
                to_regclass('public.webhook_events'), to_regclass('public.subscription_events'))

union all
-- 5) Policies dessas tabelas (escrita para o cliente = problema)
select '5 policy', format('%s."%s"', tablename, policyname),
       format('cmd=%s roles=%s using=%s check=%s', cmd, roles::text, coalesce(qual, '-'), coalesce(with_check, '-'))
from pg_policies
where schemaname = 'public'
  and tablename in ('subscriptions', 'payments', 'payment_attempts', 'payment_methods',
                    'webhook_events', 'subscription_events')

union all
-- 6) Privilégios de escrita do cliente nas tabelas (hoje)
select '6 escrita do cliente', format('%s %s', r, t),
       coalesce(string_agg(priv, ',' order by priv) filter (where has_table_privilege(r, 'public.' || t, priv)), 'nenhum')
from unnest(array['subscriptions', 'payments', 'payment_attempts', 'payment_methods',
                  'webhook_events', 'subscription_events']) t
cross join unnest(array['anon', 'authenticated']) r
cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
where to_regclass('public.' || t) is not null
group by r, t

union all
-- 7) Restrições de subscriptions (o DDL não está no repo)
select '7 constraint subscriptions', conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.subscriptions'::regclass

union all
select '7 coluna subscriptions', column_name, format('%s nullable=%s default=%s', data_type, is_nullable, coalesce(column_default, '-'))
from information_schema.columns
where table_schema = 'public' and table_name = 'subscriptions'

union all
-- 8) O que está em jogo: assinaturas pagas vigentes ou agendadas (por plano/status)
select '8 pagas vigentes/agendadas', format('%s / %s', plan_id, status),
       format('%s linha(s); início %s a %s; vence %s a %s; contas %s',
              count(*), min(started_at), max(started_at), min(expires_at), max(expires_at), count(distinct created_by))
from public.subscriptions
where plan_id <> 'basico'
  and (status = 'scheduled' or (status in ('active', 'cancelled') and expires_at > now()))
group by plan_id, status

union all
-- 9) Pagamentos (esperado: nenhum aprovado -- não há gateway)
select '9 payments', 'total / aprovados / pendentes',
       format('%s / %s / %s', count(*), count(*) filter (where status = 'approved'),
              count(*) filter (where status = 'pending'))
from public.payments

union all
-- 10) Agendamentos do pg_cron (não são alterados pela migração)
select '10 cron', jobname, format('%s | %s | ativo=%s', schedule, command, active)
from cron.job

order by 1, 2;
