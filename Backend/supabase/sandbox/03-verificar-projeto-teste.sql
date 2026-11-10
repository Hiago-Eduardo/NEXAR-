-- ==========================================================================
-- VERIFICAÇÃO DO PROJETO DE TESTE -- SÓ LEITURA (§235)
--
-- Rodar no projeto de TESTE depois de montá-lo (e de novo antes de cada
-- rodada de homologação). Só SELECT. Cada linha diz ok=true/false; tudo
-- tem de ser true antes de testar pagamentos.
-- ==========================================================================

select * from (
  select 1 as ordem, 'marcador do projeto de teste presente' as item,
         (to_regclass('nexar_sandbox.marcador') is not null)::text as valor,
         (to_regclass('nexar_sandbox.marcador') is not null) as ok
  union all
  select 2, 'marcador NÃO aponta para o principal',
         coalesce((select project_ref from nexar_sandbox.marcador), '-'),
         coalesce((select project_ref from nexar_sandbox.marcador), 'tzbawflkcivprblqzqjk') <> 'tzbawflkcivprblqzqjk'
  union all
  select 3, 'C1: subscribe_to_plan com PAYMENT_REQUIRED',
         (position('PAYMENT_REQUIRED' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.subscribe_to_plan(text)')), '')) > 0)::text,
         position('PAYMENT_REQUIRED' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.subscribe_to_plan(text)')), '')) > 0
  union all
  select 4, 'C1: anon não executa subscribe_to_plan',
         coalesce(has_function_privilege('anon', to_regprocedure('public.subscribe_to_plan(text)'), 'execute')::text, '-'),
         coalesce(not has_function_privilege('anon', to_regprocedure('public.subscribe_to_plan(text)'), 'execute'), false)
  union all
  select 5, 'gatilho trg_guard_paid_subscription ligado',
         coalesce((select tgenabled::text from pg_trigger where tgname = 'trg_guard_paid_subscription'), 'ausente'),
         exists (select 1 from pg_trigger where tgname = 'trg_guard_paid_subscription' and tgenabled = 'O')
  union all
  select 6, 'cliente sem escrita nas tabelas financeiras',
         coalesce((select string_agg(format('%s:%s:%s', r, t, priv), ' ')
                   from unnest(array['subscriptions', 'payments', 'payment_attempts', 'webhook_events', 'subscription_events',
                                     'billing_config', 'billing_customers', 'billing_reviews', 'billing_reconcile_runs']) t
                   cross join unnest(array['anon', 'authenticated']) r
                   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
                   where to_regclass('public.' || t) is not null and has_table_privilege(r, 'public.' || t, priv)), 'nenhuma'),
         not exists (select 1
                   from unnest(array['subscriptions', 'payments', 'payment_attempts', 'webhook_events', 'subscription_events',
                                     'billing_config', 'billing_customers', 'billing_reviews', 'billing_reconcile_runs']) t
                   cross join unnest(array['anon', 'authenticated']) r
                   cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
                   where to_regclass('public.' || t) is not null and has_table_privilege(r, 'public.' || t, priv))
  union all
  select 7, 'funções de cobrança fora do alcance do cliente',
         coalesce((select string_agg(p.proname, ',') from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and p.proname like 'billing\_%'
                   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), 'nenhuma'),
         not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'billing\_%'
                   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
  union all
  select 8, 'ambiente aceito = sandbox',
         coalesce((select accepted_environment from public.billing_config where id), 'NULL'),
         coalesce((select accepted_environment from public.billing_config where id), '') = 'sandbox'
  union all
  select 9, 'trigger de perfil no cadastro (auth.users)',
         exists (select 1 from pg_trigger where tgname = 'nexar_create_profile_on_signup')::text,
         exists (select 1 from pg_trigger where tgname = 'nexar_create_profile_on_signup')
  union all
  select 10, 'extensões pg_cron e pg_net',
         coalesce((select string_agg(extname, ',' order by extname) from pg_extension where extname in ('pg_cron', 'pg_net')), 'nenhuma'),
         (select count(*) from pg_extension where extname in ('pg_cron', 'pg_net')) = 2
  union all
  -- Nenhum dado do principal veio junto: só contas criadas no teste.
  select 11, 'nenhuma conta com e-mail fora de @nexar.test / teste',
         (select count(*)::text from auth.users where email !~* '(@nexar\.test$|teste|sandbox)'),
         (select count(*) from auth.users where email !~* '(@nexar\.test$|teste|sandbox)') = 0
  union all
  select 12, 'nenhum job de e-mail/manutenção copiado do principal',
         coalesce((select string_agg(jobname, ',') from cron.job where jobname <> 'nexar-billing-reconcile'), 'nenhum'),
         not exists (select 1 from cron.job where jobname <> 'nexar-billing-reconcile')
) v
order by ordem;
