-- ==========================================================================
-- C1 -- ATIVAÇÃO INDEVIDA DE PLANOS PAGOS (Resumo.md seção 231)
--
-- A FALHA
--   subscribe_to_plan(p_plan_id) é SECURITY DEFINER, tem EXECUTE para
--   `authenticated` e grava a assinatura PAGA sem olhar pagamento nenhum.
--   Qualquer conta logada -- inclusive uma conta 'cliente' -- chamava
--   supabase.rpc('subscribe_to_plan', { p_plan_id: 'premium' }) e ganhava o
--   Premium na hora (anúncios ilimitados, selo "Empresa verificada"). Três
--   caminhos dentro da mesma função davam benefício pago de graça:
--     a) SEM PLANO -> pago: linha 'active' até o próximo dia 10;
--     b) UPGRADE (Básico -> pago, Profissional -> Premium): linha 'active'
--        nova na hora;
--     c) DOWNGRADE pago -> pago (Premium -> Profissional): linha 'scheduled'
--        que, na virada do dia 10, vira mais UM ciclo pago de Profissional.
--   E como não existe renovação automática (ao vencer, a linha só expira),
--   "renovar" um plano pago também era chamar subscribe_to_plan de novo.
--
-- A CORREÇÃO
--   subscribe_to_plan passa a aceitar SOMENTE 'basico'. Qualquer plano pago
--   recebe PAYMENT_REQUIRED antes de qualquer trava, leitura ou escrita.
--   A recusa é incondicional: não depende de parâmetro, de claim do JWT, de
--   user_type, de role no app_metadata ou de flag em tabela -- não há nada
--   que o cliente (ou um admin pelo navegador) possa ligar para passar.
--   O resto do corpo é IDÊNTICO ao de plan-limits-central.sql, então o
--   Básico (assinar, agendar a troca para o Básico no fim do ciclo) segue
--   exatamente igual.
--
--   Defesa em profundidade: revoga INSERT/UPDATE/DELETE/TRUNCATE de
--   PUBLIC/anon/authenticated em subscriptions, payments, payment_attempts,
--   webhook_events e subscription_events (e INSERT/UPDATE/TRUNCATE em
--   payment_methods -- o DELETE do dono continua, tem policy própria). Hoje
--   a RLS já não tem policy de escrita nessas tabelas; o revoke impede que
--   uma policy criada por engano no painel reabra a porta. SELECT continua:
--   fornecedor_current_plan_id() é SECURITY INVOKER e é chamada pelos
--   triggers de anúncio/produto com o privilégio do próprio fornecedor.
--   As RPCs e os triggers gravam como DONO das funções (postgres), e o
--   pg_cron roda como postgres -- nenhum dos dois é afetado.
--
-- O QUE NÃO MUDA
--   cancel_my_subscription, reactivate_my_subscription, sync_my_subscription,
--   cancel_scheduled_plan_change, advance_subscription_state,
--   apply_plan_limits*, run_plan_maintenance*, preview_my_plan_change,
--   swap_plan_slot, triggers, policies, pg_cron, limites e preços. A
--   pré-verificação tira um hash de TODAS as outras funções de public e a
--   pós-verificação exige o mesmo hash.
--   reactivate_my_subscription é seguro como está: só troca status e
--   next_charge_at; expires_at e plan_id ficam -- não estende período
--   (provado no teste T8).
--
-- NENHUM DADO É ALTERADO. Nenhuma assinatura existente é cancelada,
-- rebaixada ou encurtada. Fotografia (contagem + hash) antes e depois das
-- tabelas de assinatura, pagamento, auditoria, notificação, e-mail,
-- anúncios e produtos; diferença = ABORTA.
--
-- EFEITOS NOS FLUXOS ATUAIS (ler antes de rodar)
--   * Ninguém mais contrata Profissional/Premium pelo site nem pela API até
--     existir a ativação por pagamento confirmado (gateway).
--   * Downgrade Premium -> Profissional passa a ser recusado (era o caminho
--     c). Premium/Profissional -> Básico continua.
--   * As assinaturas pagas que JÁ EXISTEM seguem até o expires_at delas (o
--     próximo dia 10). Como não há renovação, nesse dia elas expiram como
--     sempre expiraram -- e a conta só poderá assinar o Básico. A central
--     então ajusta anúncios/produtos ao Básico (ou no_plan). A seção 4 do
--     relatório lista quantas são.
--   * Linhas 'scheduled' pagas que JÁ EXISTEM (downgrade Premium ->
--     Profissional feito antes desta correção) NÃO são apagadas: na data
--     delas o agendador ainda as promove. Também aparecem no relatório --
--     decisão do usuário.
--   * `npm run test:banco` (subscription-flow.banco.test.js) foi ajustado
--     para esperar PAYMENT_REQUIRED.
--
-- A ATIVAÇÃO PAGA FUTURA (NÃO criada aqui, de propósito)
--   Uma função de ativação sem um pagamento aprovado de verdade por trás é
--   um bypass esperando para ser ligado. Ela entra junto com o gateway:
--   chamada só pelo backend (service_role, Edge Function do webhook), com
--   REVOKE de PUBLIC/anon/authenticated, exigindo uma linha em `payments`
--   com status 'approved' gravada pelo processamento do webhook (que
--   re-consulta o gateway), para aquele usuário, plano, ciclo e valor.
--
-- SUBSTITUI subscribe_to_plan de plan-limits-central.sql.
-- *** Re-rodar plan-limits-central.sql (ou billing-cycle-day-10.sql,
-- plan-change-at-period-end.sql, subscription-plan-change.sql,
-- rls-policies.sql) depois deste arquivo REABRE A FALHA C1 sem erro nenhum.
-- Se precisar reaplicar algum deles, rode este arquivo de novo por último. ***
--
-- Tudo num ÚNICO bloco DO (um comando só, atômico): pré-verificação ->
-- troca -> testes (cada um num sub-bloco que termina SEMPRE em exceção,
-- nada fica gravado) -> pós-verificação. Qualquer falha ABORTA tudo e o
-- banco fica como estava. Um bloco só porque o SQL Editor NÃO manteve
-- "begin; ...; commit;" numa transação: a 1ª tentativa (2026-11-03) caiu
-- com 42P01 "_fpa_foto does not exist" -- a temp table "on commit drop"
-- sumiu entre um comando e o seguinte. Dentro do DO nada depende disso.
-- RE-EXECUTÁVEL. Rodar MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

do $mig$
declare
  v_tab text;
begin
  -- Trava a ESCRITA de outras sessões nas tabelas fotografadas (SHARE: ler
  -- continua livre; quem for gravar espera os poucos segundos da migração).
  -- Garante que "antes" e "depois" comparam o mesmo estado, sem falso aborto
  -- por tráfego vivo (cron de e-mail a cada minuto, notificação lida...).
  -- lock_timeout: se não conseguir em 15 s, aborta sem mudar nada -- rodar
  -- de novo. Deadlock (raríssimo) = idem.
  perform set_config('lock_timeout', '15s', true);
  foreach v_tab in array array[
    'subscriptions', 'payments', 'payment_attempts', 'payment_methods', 'webhook_events',
    'subscription_events', 'notifications', 'email_outbox', 'suppliers', 'products', 'user_profiles'
  ] loop
    if to_regclass('public.' || v_tab) is not null then
      execute format('lock table public.%I in share mode', v_tab);
    end if;
  end loop;

  create temp table _fpa_testes (teste text, esperado text, obtido text, ok boolean) on commit drop;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES -- linhas + hash de cada tabela que existir
-- --------------------------------------------------------------------------
create temp table _fpa_foto (momento text, tabela text, linhas bigint, hash text) on commit drop;

create or replace function pg_temp.fpa_fotografar(p_momento text)
 returns void
 language plpgsql
as $f$
declare
  t text;
  v_n bigint;
  v_h text;
begin
  foreach t in array array[
    'subscriptions', 'payments', 'payment_attempts', 'payment_methods', 'webhook_events',
    'subscription_events', 'notifications', 'email_outbox', 'suppliers', 'products',
    'user_profiles'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format(
        'select count(*), md5(coalesce(string_agg(to_jsonb(x)::text, ''|'' order by to_jsonb(x)::text), '''')) from public.%I x', t)
        into v_n, v_h;
      insert into _fpa_foto values (p_momento, t, v_n, v_h);
    end if;
  end loop;

  -- Todas as funções de public MENOS a que este arquivo troca: corpo,
  -- security definer, SET (search_path), dono e ACL. Tem que sair igual.
  insert into _fpa_foto
  select p_momento, 'funcoes(exceto subscribe_to_plan)', count(*),
         md5(coalesce(string_agg(
           p.oid::regprocedure::text || ':' || md5(coalesce(p.prosrc, '')) || ':' || p.prosecdef::text
           || ':' || coalesce(array_to_string(p.proconfig, ','), '') || ':' || pg_get_userbyid(p.proowner)
           -- ACL das três que perdem anon fica de fora (conferido no P7)
           || ':' || case when p.proname in ('cancel_scheduled_plan_change', 'my_current_subscription',
                                             'my_scheduled_subscription') then '' else coalesce(p.proacl::text, '') end,
           '|' order by p.oid::regprocedure::text), ''))
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname <> 'subscribe_to_plan';

  -- Policies de public: nenhuma pode mudar.
  insert into _fpa_foto
  select p_momento, 'policies(public)', count(*),
         md5(coalesce(string_agg(
           tablename || ':' || policyname || ':' || cmd || ':' || roles::text || ':'
           || coalesce(qual, '') || ':' || coalesce(with_check, ''),
           '|' order by tablename, policyname), ''))
  from pg_policies where schemaname = 'public';

  -- Agendamentos do pg_cron (quando a extensão existe).
  if to_regclass('cron.job') is not null then
    execute $q$
      insert into _fpa_foto
      select $1, 'cron.job', count(*),
             md5(coalesce(string_agg(jobname || ':' || schedule || ':' || command || ':' || active::text,
                                     '|' order by jobname), ''))
      from cron.job
    $q$ using p_momento;
  end if;
end;
$f$;

perform pg_temp.fpa_fotografar('antes');


-- --------------------------------------------------------------------------
-- 1) PRÉ-VERIFICAÇÃO -- aborta se o banco não é o que este arquivo supõe
-- --------------------------------------------------------------------------
declare
  v_src text;
  v_n int;
  v_list text;
  v_owner text;
begin
  -- 1a. Sobrecargas: uma só versão de cada RPC de assinatura.
  select string_agg(format('%s x%s', proname, n), ', ') into v_list
  from (
    select p.proname, count(*) as n
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('subscribe_to_plan', 'cancel_my_subscription', 'reactivate_my_subscription',
                        'sync_my_subscription', 'cancel_scheduled_plan_change')
    group by p.proname
    having count(*) > 1
  ) s;
  if v_list is not null then
    raise exception 'PRECHECK: sobrecargas inesperadas: % -- uma delas pode continuar ativando plano pago. Nada foi alterado.', v_list;
  end if;

  select count(*) into v_n from pg_proc
  where pronamespace = 'public'::regnamespace and proname = 'subscribe_to_plan';
  if v_n <> 1 then
    raise exception 'PRECHECK: subscribe_to_plan não encontrada (% versões). Nada foi alterado.', v_n;
  end if;

  -- 1b. O corpo vivo tem de ser o de plan-limits-central.sql (ou este, numa
  --     reaplicação). Outro corpo = alguém re-rodou um arquivo antigo: o
  --     corpo novo abaixo seria escrito em cima de regras que não conhecemos.
  select prosrc, pg_get_userbyid(proowner) into v_src, v_owner
  from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure;

  if position('subscribe_to_plan:new' in v_src) = 0
     or position('subscribe_to_plan:upgrade' in v_src) = 0
     or position('subscribe_to_plan:downgrade' in v_src) = 0
     or position('advance_subscription_state' in v_src) = 0
     or position('lock_plan_account' in v_src) = 0 then
    raise exception 'PRECHECK: o corpo vivo de subscribe_to_plan NÃO é o de plan-limits-central.sql. Confira com: select prosrc from pg_proc where proname = ''subscribe_to_plan''. Nada foi alterado.';
  end if;

  if v_owner in ('anon', 'authenticated', 'service_role') then
    raise exception 'PRECHECK: subscribe_to_plan pertence a %, não ao postgres. Nada foi alterado.', v_owner;
  end if;

  -- 1c. Tabelas: RLS ligada e nenhuma policy de escrita para o cliente.
  select string_agg(t, ', ') into v_list
  from unnest(array['subscriptions', 'payments', 'payment_attempts', 'payment_methods',
                    'webhook_events', 'subscription_events']) t
  where to_regclass('public.' || t) is null
     or not (select relrowsecurity from pg_class where oid = to_regclass('public.' || t));
  if v_list is not null then
    raise exception 'PRECHECK: tabela ausente ou com RLS DESLIGADA: %. Nada foi alterado.', v_list;
  end if;

  select string_agg(format('%s."%s" (%s, %s)', tablename, policyname, cmd, roles::text), '; ') into v_list
  from pg_policies
  where schemaname = 'public'
    and tablename in ('subscriptions', 'payments', 'payment_attempts', 'payment_methods',
                      'webhook_events', 'subscription_events')
    and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    and not (tablename = 'payment_methods' and policyname = 'Owners delete own payment methods' and cmd = 'DELETE');
  if v_list is not null then
    raise exception 'PRECHECK: policy de escrita inesperada: % -- pode ser outra via de forjar assinatura/pagamento; investigar antes. Nada foi alterado.', v_list;
  end if;

  -- 1d. Outra função chamável pelo cliente que grave em subscriptions ou
  --     payments? (Funções de trigger ficam de fora: PostgREST não as chama.)
  select string_agg(p.oid::regprocedure::text, ', ') into v_list
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prorettype <> 'trigger'::regtype
    and p.prokind = 'f'
    and (has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('anon', p.oid, 'execute'))
    and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?(subscriptions|payments|payment_attempts)\M'
    and p.proname not in ('subscribe_to_plan', 'cancel_my_subscription', 'reactivate_my_subscription',
                          'cancel_scheduled_plan_change');
  if v_list is not null then
    raise exception 'PRECHECK: funções chamáveis pelo cliente que gravam em assinatura/pagamento e que este arquivo não conhece: %. Nada foi alterado.', v_list;
  end if;
end;


-- --------------------------------------------------------------------------
-- 2) A TROCA -- corpo de plan-limits-central.sql + a guarda C1.
--    Diferenças, e só elas:
--      * p_plan_id NULL agora é INVALID_PLAN (antes `null not in (...)` dava
--        NULL e passava direto);
--      * PAYMENT_REQUIRED para todo plano que não seja 'basico', ANTES de
--        travar, sincronizar ou gravar qualquer coisa;
--      * search_path 'public', 'pg_temp' (pg_temp por último: uma tabela
--        temporária não consegue sombrear as de public).
-- --------------------------------------------------------------------------
create or replace function public.subscribe_to_plan(p_plan_id text)
 returns public.subscriptions
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscriptions;
  v_row public.subscriptions;
  v_end timestamptz;
  v_starts timestamptz;
  v_is_paid boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_plan_id is null or p_plan_id not in ('basico', 'profissional', 'premium') then
    raise exception 'INVALID_PLAN';
  end if;

  -- C1 (Resumo.md seção 231): plano pago NÃO é ativado por esta RPC. Nem
  -- assinatura nova, nem upgrade, nem troca agendada para outro plano pago.
  -- A ativação paga virá de uma função só do backend, presa a um pagamento
  -- aprovado em `payments` -- nunca de algo que o navegador envie.
  if p_plan_id is distinct from 'basico' then
    raise exception 'PAYMENT_REQUIRED'
      using hint = 'Planos pagos só são ativados depois de pagamento confirmado. A contratação online ainda não está disponível.';
  end if;

  perform public.lock_plan_account(v_uid);
  -- Estado em dia ANTES de decidir (ver advance_subscription_state).
  perform public.advance_subscription_state(v_uid);

  v_is_paid := p_plan_id <> 'basico';

  select * into v_current
  from public.subscriptions
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and started_at <= now()
    and expires_at > now()
  order by started_at desc
  limit 1;

  -- ---------- SEM PLANO VIGENTE: entra na hora, ciclo parcial ----------
  if v_current.id is null then
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

    v_end := public.next_billing_date(now());

    insert into public.subscriptions (
      created_by, plan_id, status, started_at, expires_at,
      next_charge_at, first_cycle_partial, partial_days
    )
    values (
      v_uid, p_plan_id, 'active', now(),
      case when v_is_paid then v_end else 'infinity'::timestamptz end,
      case when v_is_paid then v_end else null end,
      v_is_paid,
      case when v_is_paid then greatest(1, (v_end::date - now()::date)) else null end
    )
    returning * into v_row;

    -- A assinatura já está gravada. A central ajusta os itens ao limite e,
    -- se falhar, não a desfaz.
    perform public.apply_plan_limits_safe(v_uid, 'subscribe_to_plan:new');
    return v_row;
  end if;

  if v_current.plan_id = p_plan_id then
    raise exception 'ALREADY_ON_PLAN';
  end if;

  -- ---------- UPGRADE: vale agora, SEM cobrança agora ----------
  if public.plan_rank(p_plan_id) > public.plan_rank(v_current.plan_id) then
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

    if not v_is_paid then
      v_end := 'infinity'::timestamptz;
    elsif v_current.expires_at = 'infinity'::timestamptz then
      v_end := public.next_billing_date(now());
    else
      v_end := greatest(v_current.expires_at, public.next_billing_date(now()));
    end if;

    update public.subscriptions
    set status = 'expired', expires_at = now(), next_charge_at = null
    where id = v_current.id;

    insert into public.subscriptions (
      created_by, plan_id, status, started_at, expires_at,
      next_charge_at, first_cycle_partial, partial_days
    )
    values (
      v_uid, p_plan_id, 'active', now(), v_end,
      case when v_is_paid then v_end else null end,
      false, null
    )
    returning * into v_row;

    perform public.apply_plan_limits_safe(v_uid, 'subscribe_to_plan:upgrade');
    return v_row;
  end if;

  -- ---------- DOWNGRADE: vale no fim do ciclo (dia 10) ----------
  -- Nada muda nos itens agora: o plano atual segue intacto até a virada, que
  -- o agendador (ou o sync) aplica.
  if v_current.expires_at = 'infinity'::timestamptz then
    raise exception 'CANNOT_SCHEDULE_FROM_UNLIMITED_PLAN';
  end if;

  v_starts := v_current.expires_at;

  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  insert into public.subscriptions (
    created_by, plan_id, status, started_at, expires_at,
    next_charge_at, first_cycle_partial, partial_days
  )
  values (
    v_uid, p_plan_id, 'scheduled', v_starts,
    case when v_is_paid then public.next_billing_date(v_starts) else 'infinity'::timestamptz end,
    case when v_is_paid then v_starts else null end,
    false, null
  )
  returning * into v_row;

  -- O plano vigente não muda; a chamada só garante que os itens refletem o
  -- estado que advance_subscription_state possa ter acabado de promover.
  perform public.apply_plan_limits_safe(v_uid, 'subscribe_to_plan:downgrade');
  return v_row;
end;
$function$;

-- create or replace preserva o ACL; repetido para o arquivo valer sozinho.
revoke execute on function public.subscribe_to_plan(text) from public, anon;
grant execute on function public.subscribe_to_plan(text) to authenticated;

-- Diagnóstico de 2026-11-03: estas três estavam executáveis por anon. Não é
-- falha (usam auth.uid(), nulo para anon), mas o site só as chama com login
-- (client.js confere o usuário antes). Só o ACL muda; o corpo, não.
revoke execute on function public.cancel_scheduled_plan_change() from public, anon;
revoke execute on function public.my_current_subscription() from public, anon;
revoke execute on function public.my_scheduled_subscription() from public, anon;
grant execute on function public.cancel_scheduled_plan_change() to authenticated;
grant execute on function public.my_current_subscription() to authenticated;
grant execute on function public.my_scheduled_subscription() to authenticated;


-- --------------------------------------------------------------------------
-- 3) ESCRITA DIRETA DO CLIENTE NAS TABELAS FINANCEIRAS -- fechada
--    SELECT fica (as policies de leitura do dono continuam valendo).
-- --------------------------------------------------------------------------
revoke insert, update, delete, truncate on public.subscriptions       from public, anon, authenticated;
revoke insert, update, delete, truncate on public.payments            from public, anon, authenticated;
revoke insert, update, delete, truncate on public.payment_attempts    from public, anon, authenticated;
revoke insert, update, delete, truncate on public.webhook_events      from public, anon, authenticated;
revoke insert, update, delete, truncate on public.subscription_events from public, anon, authenticated;
-- payment_methods: o dono continua podendo APAGAR o próprio método (policy
-- "Owners delete own payment methods"); criar/alterar, não.
revoke insert, update, truncate on public.payment_methods from public, anon, authenticated;


-- --------------------------------------------------------------------------
-- 4) TESTES -- tudo desfeito
--
-- Cada cenário roda num sub-bloco que termina SEMPRE em exceção ('FIM:...'):
-- o Postgres desfaz as linhas, eventos, notificações, e-mails da fila, o
-- `set role` e as claims. As contas são DESCARTÁVEIS (criadas em auth.users
-- dentro do próprio sub-bloco, e-mail @nexar.test, nunca enviado: o envio
-- sai de um cron que só vê linhas commitadas). Se o banco não deixar criar
-- conta, o teste usa uma conta existente, zera as assinaturas DELA dentro do
-- sub-bloco e tudo volta no fim -- a coluna `obtido` diz qual foi usada.
-- O fornecedor é simulado como no PostgREST: role authenticated + JWT.
-- --------------------------------------------------------------------------
create or replace function pg_temp.fpa_conta(p_tipo text, p_n int default 0)
 returns uuid
 language plpgsql
as $f$
declare
  v uuid := gen_random_uuid();
begin
  begin
    insert into auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
    values (v, 'c1-' || p_tipo || '-' || left(v::text, 8) || '@nexar.test', 'authenticated', 'authenticated',
            jsonb_build_object('role', p_tipo, 'user_type', p_tipo), '{}'::jsonb, now(), now());
  exception when others then
    select id into v from auth.users order by created_at, id offset p_n limit 1;
    if v is null then
      raise exception 'FPA_SEM_CONTA: não foi possível criar conta descartável (%) e não há conta existente', sqlerrm;
    end if;
    -- Conta real: zera as assinaturas DELA dentro do sub-bloco (desfeito).
    delete from public.subscriptions where created_by = v;
  end;
  return v;
end;
$f$;

create or replace function pg_temp.fpa_assinatura(p_uid uuid, p_plan text, p_status text,
                                                  p_start timestamptz, p_end timestamptz)
 returns uuid
 language plpgsql
as $f$
declare
  v uuid;
  v_pay uuid;
begin
  -- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
  -- só aceita linha paga ligada a um pagamento aprovado. O teste cria um
  -- (ambiente ligado só dentro do sub-bloco, que é desfeito). SQL dinâmico:
  -- antes de asaas-billing.sql as colunas não existem.
  if p_plan <> 'basico' and exists (
       select 1 from pg_trigger where tgname = 'trg_guard_paid_subscription'
       and tgrelid = 'public.subscriptions'::regclass) then
    execute 'update public.billing_config set accepted_environment = coalesce(accepted_environment, ''sandbox'')';
    execute 'insert into public.payments (created_by, plan_id, billing_cycle, amount_cents, status, gateway,
                                          environment, covers_until, paid_at)
             values ($1, $2, current_date, 100, ''approved'', ''asaas'',
                     public.billing_accepted_environment(), $3, now()) returning id'
      into v_pay using p_uid, p_plan, p_end;
    execute 'insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, next_charge_at, payment_id)
             values ($1, $2, $3, $4, $5, $5, $6) returning id'
      into v using p_uid, p_plan, p_status, p_start, p_end, v_pay;
    return v;
  end if;
  insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, next_charge_at)
  values (p_uid, p_plan, p_status, p_start, p_end,
          case when p_plan <> 'basico' and p_status in ('active', 'scheduled') then p_end end)
  returning id into v;
  return v;
end;
$f$;

create or replace function pg_temp.fpa_registrar(p_teste text, p_esperado text, p_obtido text)
 returns void
 language sql
as $f$
  insert into _fpa_testes values (p_teste, p_esperado, p_obtido, p_obtido = p_esperado);
$f$;

declare
  v_me text := current_user;
  v_a uuid;
  v_b uuid;
  v_id uuid;
  v_sub public.subscriptions;
  v_antes public.subscriptions;
  v_err text;
  v_res text;
  v_j jsonb;
  v_p text;
  v_bad text;
begin
  -- T1. Sem plano -> Básico: contrata, vigência infinita.
  begin
    v_a := pg_temp.fpa_conta('fornecedor');
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    v_sub := public.subscribe_to_plan('basico');
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', format('%s/%s/%s/plano_vigente=%s', v_sub.plan_id, v_sub.status,
      (v_sub.expires_at = 'infinity')::text, public.fornecedor_current_plan_id(v_a));
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T1 sem plano -> Básico', 'basico/active/true/plano_vigente=basico', v_res);

  -- T2/T3. Básico -> Profissional / Premium: recusado, Básico intacto.
  foreach v_p in array array['profissional', 'premium'] loop
    begin
      v_a := pg_temp.fpa_conta('fornecedor');
      v_id := pg_temp.fpa_assinatura(v_a, 'basico', 'active', now() - interval '1 day', 'infinity');
      select * into v_antes from public.subscriptions where id = v_id;
      perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      begin
        perform public.subscribe_to_plan(v_p);
        v_err := 'ACEITOU';
      exception when others then v_err := sqlerrm;
      end;
      perform set_config('role', v_me, true);
      raise exception 'FIM:%', format('%s/linhas=%s/basico_intacto=%s/plano_vigente=%s', v_err,
        (select count(*) from public.subscriptions where created_by = v_a),
        ((select to_jsonb(s) from public.subscriptions s where s.id = v_id) = to_jsonb(v_antes))::text,
        public.fornecedor_current_plan_id(v_a));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.fpa_registrar('T2/T3 Básico -> ' || v_p || ' de graça',
      'PAYMENT_REQUIRED/linhas=1/basico_intacto=true/plano_vigente=basico', v_res);
  end loop;

  -- T4. Sem plano -> Premium / Profissional direto pela RPC: recusado, nada gravado.
  foreach v_p in array array['premium', 'profissional'] loop
    begin
      v_a := pg_temp.fpa_conta('fornecedor');
      perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      begin
        perform public.subscribe_to_plan(v_p);
        v_err := 'ACEITOU';
      exception when others then v_err := sqlerrm;
      end;
      perform set_config('role', v_me, true);
      raise exception 'FIM:%', format('%s/linhas=%s/eventos=%s', v_err,
        (select count(*) from public.subscriptions where created_by = v_a),
        -- só os eventos desta transação (conta existente tem histórico)
        (select count(*) from public.subscription_events where created_by = v_a and created_at >= now()));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.fpa_registrar('T4 sem plano -> ' || v_p || ' pela RPC', 'PAYMENT_REQUIRED/linhas=0/eventos=0', v_res);
  end loop;

  -- T5. Conta CLIENTE: nada pago, nem selo.
  begin
    v_a := pg_temp.fpa_conta('cliente');
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_a, 'role', 'authenticated', 'user_metadata', json_build_object('role', 'cliente'))::text, true);
    perform set_config('role', 'authenticated', true);
    v_res := '';
    foreach v_p in array array['premium', 'profissional'] loop
      begin
        perform public.subscribe_to_plan(v_p);
        v_res := v_res || 'ACEITOU;';
      exception when others then v_res := v_res || sqlerrm || ';';
      end;
    end loop;
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', format('%s/linhas=%s/plano=%s', v_res,
      (select count(*) from public.subscriptions where created_by = v_a),
      coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'));
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T5 conta cliente -> Premium/Profissional',
    'PAYMENT_REQUIRED;PAYMENT_REQUIRED;/linhas=0/plano=nenhum', v_res);

  -- T6. Mexer DIRETO na tabela (outra conta e a própria): sem permissão.
  begin
    v_a := pg_temp.fpa_conta('fornecedor', 0);
    v_b := pg_temp.fpa_conta('fornecedor', 1);
    v_id := pg_temp.fpa_assinatura(v_b, 'basico', 'active', now() - interval '1 day', 'infinity');
    perform pg_temp.fpa_assinatura(v_a, 'basico', 'active', now() - interval '1 day', 'infinity');
    select * into v_antes from public.subscriptions where id = v_id;
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    v_res := '';
    begin
      update public.subscriptions set plan_id = 'premium', expires_at = 'infinity' where id = v_id;
      v_res := v_res || 'upd_outra=PASSOU;';
    exception when others then v_res := v_res || 'upd_outra=' || sqlstate || ';';
    end;
    begin
      update public.subscriptions set plan_id = 'premium' where created_by = v_a;
      v_res := v_res || 'upd_propria=PASSOU;';
    exception when others then v_res := v_res || 'upd_propria=' || sqlstate || ';';
    end;
    begin
      insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
      values (v_a, 'premium', 'active', now(), 'infinity');
      v_res := v_res || 'ins=PASSOU;';
    exception when others then v_res := v_res || 'ins=' || sqlstate || ';';
    end;
    begin
      delete from public.subscriptions where id = v_id;
      v_res := v_res || 'del_outra=PASSOU;';
    exception when others then v_res := v_res || 'del_outra=' || sqlstate || ';';
    end;
    begin
      insert into public.payments (created_by, plan_id, billing_cycle, amount_cents, status)
      values (v_a, 'premium', current_date, 9900, 'approved');
      v_res := v_res || 'pagamento=PASSOU;';
    exception when others then v_res := v_res || 'pagamento=' || sqlstate || ';';
    end;
    begin
      insert into public.subscription_events (created_by, event_type) values (v_a, 'subscription_started');
      v_res := v_res || 'evento=PASSOU;';
    exception when others then v_res := v_res || 'evento=' || sqlstate || ';';
    end;
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', v_res || format('outra_intacta=%s',
      ((select to_jsonb(s) from public.subscriptions s where s.id = v_id) = to_jsonb(v_antes))::text);
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T6 escrita direta (outra conta e própria)',
    'upd_outra=42501;upd_propria=42501;ins=42501;del_outra=42501;pagamento=42501;evento=42501;outra_intacta=true', v_res);

  -- T7. Parâmetros adulterados + claims forjadas: nada passa.
  begin
    v_a := pg_temp.fpa_conta('fornecedor');
    v_bad := '';
    perform set_config('role', 'authenticated', true);
    foreach v_p in array array['premium', 'Premium', 'PREMIUM', ' premium', 'premium ', 'profissional ',
                               '', 'ouro', 'essencial', 'premium''--', 'basico,premium'] loop
      perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      begin
        perform public.subscribe_to_plan(v_p);
        v_bad := v_bad || format('[%s] ACEITOU;', v_p);
      exception when others then
        if sqlerrm not in ('PAYMENT_REQUIRED', 'INVALID_PLAN') then
          v_bad := v_bad || format('[%s] %s;', v_p, sqlerrm);
        end if;
      end;
    end loop;
    begin
      perform public.subscribe_to_plan(null);
      v_bad := v_bad || '[null] ACEITOU;';
    exception when others then
      if sqlerrm <> 'INVALID_PLAN' then v_bad := v_bad || '[null] ' || sqlerrm || ';'; end if;
    end;
    -- JWT dizendo admin / service_role / pagamento confirmado: ignorado.
    perform set_config('request.jwt.claims', json_build_object(
      'sub', v_a, 'role', 'service_role', 'paid', true, 'payment_confirmed', true,
      'app_metadata', json_build_object('role', 'admin'),
      'user_metadata', json_build_object('role', 'admin'))::text, true);
    begin
      perform public.subscribe_to_plan('premium');
      v_bad := v_bad || '[claims admin/service_role] ACEITOU;';
    exception when others then
      if sqlerrm <> 'PAYMENT_REQUIRED' then v_bad := v_bad || '[claims] ' || sqlerrm || ';'; end if;
    end;
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', format('falhas=[%s]/linhas=%s', v_bad,
      (select count(*) from public.subscriptions where created_by = v_a));
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T7 parâmetros/claims adulterados', 'falhas=[]/linhas=0', v_res);

  -- T8. Reativar: não estende período nem troca plano; vencida não volta;
  --     cancelada não "renova" assinando de novo.
  begin
    v_a := pg_temp.fpa_conta('fornecedor');
    -- Assinatura paga legítima (como se paga), vigente até o próximo dia 10.
    v_id := pg_temp.fpa_assinatura(v_a, 'premium', 'active', now() - interval '3 days', public.next_billing_date(now()));
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    perform public.cancel_my_subscription();
    select * into v_antes from public.subscriptions where id = v_id;
    v_sub := public.reactivate_my_subscription();
    v_res := format('reativou=%s/mesmo_id=%s/expira_igual=%s/plano_igual=%s/inicio_igual=%s/linhas=%s;',
      v_sub.status, (v_sub.id = v_id)::text, (v_sub.expires_at = v_antes.expires_at)::text,
      (v_sub.plan_id = v_antes.plan_id)::text, (v_sub.started_at = v_antes.started_at)::text,
      (select count(*) from public.subscriptions where created_by = v_a));
    -- cancelada e assinando o mesmo pago de novo: recusado
    perform public.cancel_my_subscription();
    begin
      perform public.subscribe_to_plan('premium');
      v_res := v_res || 'reassinar=ACEITOU;';
    exception when others then v_res := v_res || 'reassinar=' || sqlerrm || ';';
    end;
    -- venceu cancelada: reativar não ressuscita
    perform set_config('role', v_me, true);
    update public.subscriptions set expires_at = now() - interval '1 second' where id = v_id;
    perform set_config('role', 'authenticated', true);
    begin
      perform public.reactivate_my_subscription();
      v_res := v_res || 'vencida=ACEITOU;';
    exception when others then v_res := v_res || 'vencida=' || sqlerrm || ';';
    end;
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', v_res || format('plano=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'));
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T8 reativação não concede período novo',
    'reativou=active/mesmo_id=true/expira_igual=true/plano_igual=true/inicio_igual=true/linhas=1;reassinar=PAYMENT_REQUIRED;vencida=NO_CANCELLED_SUBSCRIPTION;plano=nenhum',
    v_res);

  -- T9. Cancelamento e downgrade continuam; downgrade pago->pago recusado.
  begin
    v_a := pg_temp.fpa_conta('fornecedor');
    v_id := pg_temp.fpa_assinatura(v_a, 'premium', 'active', now() - interval '3 days', public.next_billing_date(now()));
    select * into v_antes from public.subscriptions where id = v_id;
    perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    begin
      perform public.subscribe_to_plan('profissional');
      v_res := 'premium->profissional=ACEITOU;';
    exception when others then v_res := 'premium->profissional=' || sqlerrm || ';';
    end;
    v_res := v_res || format('agendadas=%s;', (select count(*) from public.subscriptions where created_by = v_a and status = 'scheduled'));
    v_sub := public.subscribe_to_plan('basico');
    v_res := v_res || format('premium->basico=%s/%s/emenda=%s/premium_intacto=%s;', v_sub.plan_id, v_sub.status,
      (v_sub.started_at = v_antes.expires_at)::text,
      ((select to_jsonb(s) from public.subscriptions s where s.id = v_id) = to_jsonb(v_antes))::text);
    perform public.cancel_scheduled_plan_change();
    v_res := v_res || format('desfazer=%s;', (select count(*) from public.subscriptions where created_by = v_a and status = 'scheduled'));
    v_sub := public.cancel_my_subscription();
    v_res := v_res || format('cancelar_pago=%s/expira_igual=%s/cobranca=%s;', v_sub.status,
      (v_sub.expires_at = v_antes.expires_at)::text, coalesce(v_sub.next_charge_at::text, 'null'));
    perform set_config('role', v_me, true);
    -- Básico: cancelar encerra na hora
    v_b := v_a;
    delete from public.subscriptions where created_by = v_b;
    perform pg_temp.fpa_assinatura(v_b, 'basico', 'active', now() - interval '1 day', 'infinity');
    perform set_config('role', 'authenticated', true);
    v_sub := public.cancel_my_subscription();
    perform set_config('role', v_me, true);
    raise exception 'FIM:%', v_res || format('cancelar_basico=%s/sem_plano=%s', v_sub.status,
      (public.fornecedor_current_plan_id(v_b) is null)::text);
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T9 cancelamento e downgrade',
    'premium->profissional=PAYMENT_REQUIRED;agendadas=0;premium->basico=basico/scheduled/emenda=true/premium_intacto=true;desfazer=0;cancelar_pago=cancelled/expira_igual=true/cobranca=null;cancelar_basico=cancelled/sem_plano=true',
    v_res);

  -- T10. Tarefas internas (o que o pg_cron chama) seguem funcionando:
  --      vencimento + virada de downgrade agendado + central.
  begin
    v_a := pg_temp.fpa_conta('fornecedor');
    v_id := pg_temp.fpa_assinatura(v_a, 'premium', 'active', now() - interval '30 days', now() - interval '1 minute');
    perform pg_temp.fpa_assinatura(v_a, 'basico', 'scheduled', now() - interval '1 minute', 'infinity');
    v_j := public.sync_subscription_for(v_a, 'teste_c1');
    raise exception 'FIM:%', format('premium=%s/plano=%s/central_falhou=%s/limites=%s,%s,%s',
      (select status from public.subscriptions where id = v_id),
      coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'),
      coalesce(v_j ->> 'failed', 'false'),
      public.plan_ad_limit('basico'), public.plan_ad_limit('profissional'),
      case when public.plan_ad_limit('premium') >= 2147483647 then 'ilimitado' else public.plan_ad_limit('premium')::text end);
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform pg_temp.fpa_registrar('T10 sync interno + limites',
    'premium=expired/plano=basico/central_falhou=false/limites=1,5,ilimitado', v_res);
end;

-- Permissões, depois.
insert into _fpa_testes
select 'P1 anon executa subscribe_to_plan', 'false',
       has_function_privilege('anon', 'public.subscribe_to_plan(text)', 'execute')::text, null::boolean
union all
select 'P2 authenticated executa subscribe_to_plan (Básico)', 'true',
       has_function_privilege('authenticated', 'public.subscribe_to_plan(text)', 'execute')::text, null
union all
select 'P3 escrita do cliente nas tabelas financeiras', '',
       coalesce(string_agg(format('%s:%s:%s', r, t, priv), ' '), ''), null
from unnest(array['subscriptions', 'payments', 'payment_attempts', 'webhook_events', 'subscription_events']) t
cross join unnest(array['anon', 'authenticated']) r
cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
where has_table_privilege(r, 'public.' || t, priv)
union all
select 'P4 payment_methods: cliente não cria nem altera (o DELETE do dono fica como está)', '',
       coalesce(string_agg(priv, ',' order by priv), ''), null
from unnest(array['INSERT', 'UPDATE', 'TRUNCATE']) priv
where has_table_privilege('authenticated', 'public.payment_methods', priv)
union all
select 'P5 SELECT do dono preservado', 'true,true',
       has_table_privilege('authenticated', 'public.subscriptions', 'SELECT')::text || ','
       || has_table_privilege('authenticated', 'public.payments', 'SELECT')::text, null
union all
select 'P6 corpo vivo tem a guarda', 'true',
       (position('PAYMENT_REQUIRED' in (select prosrc from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure)) > 0)::text,
       null;
insert into _fpa_testes
select 'P7 ' || f || ': anon / authenticated', 'false/true',
       has_function_privilege('anon', ('public.' || f || '()')::regprocedure, 'execute')::text || '/'
       || has_function_privilege('authenticated', ('public.' || f || '()')::regprocedure, 'execute')::text, null::boolean
from unnest(array['cancel_scheduled_plan_change', 'my_current_subscription', 'my_scheduled_subscription']) f;
update _fpa_testes set ok = (obtido = esperado) where ok is null;


-- --------------------------------------------------------------------------
-- 5) PÓS-VERIFICAÇÃO -- nenhum dado, função, policy ou cron mudou
-- --------------------------------------------------------------------------
perform pg_temp.fpa_fotografar('depois');

declare
  v_diff text;
  v_falhas text;
begin
  select string_agg(format('%s (antes %s/%s, depois %s/%s)', a.tabela, a.linhas, left(a.hash, 8),
                           coalesce(d.linhas::text, '-'), left(coalesce(d.hash, '-'), 8)), '; ')
    into v_diff
  from _fpa_foto a
  left join _fpa_foto d on d.tabela = a.tabela and d.momento = 'depois'
  where a.momento = 'antes'
    and (d.tabela is null or (a.linhas, a.hash) is distinct from (d.linhas, d.hash));
  if v_diff is not null then
    raise exception 'ABORTADO: algo mudou além de subscribe_to_plan e dos grants: %', v_diff;
  end if;

  select string_agg(format('%s => esperado [%s] obtido [%s]', teste, esperado, obtido), E'\n') into v_falhas
  from _fpa_testes where ok is not true;
  if v_falhas is not null then
    raise exception E'ABORTADO: teste(s) falharam -- nada foi aplicado:\n%', v_falhas;
  end if;
end;

-- Resumo para o select final (variável de sessão; sobrevive ao fim do DO).
perform set_config('nexar.fpa_resultado',
  (select format('%s/%s testes ok', count(*) filter (where ok), count(*)) from _fpa_testes), false);
end
$mig$;

notify pgrst, 'reload schema';

-- Resultado. O DO acima só termina sem erro se TODOS os testes passaram e
-- nada mudou além do previsto; este select confere o estado depois.
select 1 as ordem, 'testes embutidos' as item,
       coalesce(current_setting('nexar.fpa_resultado', true), 'todos ok (DO terminou sem erro)') as valor
union all
select 2, 'guarda C1 (PAYMENT_REQUIRED) no corpo vivo de subscribe_to_plan',
       (position('PAYMENT_REQUIRED' in prosrc) > 0)::text
from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure
union all
select 3, 'subscribe_to_plan executável por anon / authenticated',
       has_function_privilege('anon', 'public.subscribe_to_plan(text)', 'execute')::text || ' / '
       || has_function_privilege('authenticated', 'public.subscribe_to_plan(text)', 'execute')::text
union all
select 4, 'escrita do cliente nas tabelas financeiras',
       coalesce(string_agg(format('%s:%s:%s', r, t, priv), ' '), 'nenhuma')
from unnest(array['subscriptions', 'payments', 'payment_attempts', 'webhook_events', 'subscription_events']) t
cross join unnest(array['anon', 'authenticated']) r
cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
where has_table_privilege(r, 'public.' || t, priv)
union all
select 5, 'anon executa cancel_scheduled / my_current / my_scheduled',
       has_function_privilege('anon', 'public.cancel_scheduled_plan_change()', 'execute')::text || ' / '
       || has_function_privilege('anon', 'public.my_current_subscription()', 'execute')::text || ' / '
       || has_function_privilege('anon', 'public.my_scheduled_subscription()', 'execute')::text
order by 1;
