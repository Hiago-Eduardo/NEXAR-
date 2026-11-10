-- ==========================================================================
-- MANUTENÇÃO DE PLANOS -- commit por conta, log por execução, travas só onde
-- há mudança, limpeza do histórico
--
-- Corrige os problemas A, D, E e F da auditoria do agendador (Resumo.md
-- seções 188-189; B e C já foram corrigidos por plan-maintenance-guard.sql).
--
-- A) TRAVAS PRESAS ATÉ O FIM DA VARREDURA
--    O job passa a chamar a PROCEDURE run_plan_maintenance_job(), que dá
--    COMMIT depois de CADA conta: as travas da conta (conta/linhas/anúncios/
--    produtos) soltam assim que ela termina, e um erro ou statement_timeout
--    no meio só perde a conta em andamento -- as anteriores já estão gravadas.
--    A trava GLOBAL nexar:maintenance vira trava de SESSÃO (sobrevive aos
--    commits); outra manutenção que chegar continua saindo na hora (skipped).
--    Uma procedure com SECURITY DEFINER ou SET não pode dar COMMIT, por isso
--    ela é security invoker e sem SET: roda como quem chama (o postgres, no
--    pg_cron) e só usa nomes qualificados.
--
-- D) LOG POR EXECUÇÃO
--    Tabela plan_maintenance_runs: uma linha por execução (início, fim,
--    status running/done/skipped/aborted, contas, limpas, travadas, mudadas,
--    falhas). Uma execução que morreu no meio fica 'running' e a próxima que
--    pegar a trava global a marca 'aborted'. Só o postgres lê (RLS sem policy,
--    sem grant para anon/authenticated).
--
-- E) FOR UPDATE EM TODA PASSADA
--    Antes de travar uma conta, a manutenção pergunta SEM TRAVAR:
--      * há transição de assinatura pendente (vencida, ou agendada cuja data
--        chegou)?  -> subscription_transition_pending(uid)
--      * a central mudaria algo?  -> preview_plan_limits(uid), só leitura
--    Se as duas dizem "não", a conta é 'clean' e nada é travado nem escrito.
--    A leitura sem trava pode estar um instante atrasada em relação a uma
--    transação em andamento; nesse caso a mudança fica para a passada seguinte
--    (10 min) -- a segurança de ESCRITA nunca dependeu do agendador (triggers
--    e RPCs checam o plano na hora, seção 188).
--
-- F) cron.job_run_details SEM LIMPEZA
--    Job diário nexar-maintenance-prune (06:17 UTC = 03:17 BRT) chama
--    prune_maintenance_history(): apaga cron.job_run_details com mais de 7
--    dias e plan_maintenance_runs com mais de 30.
--
-- SUBSTITUI run_plan_maintenance (de plan-maintenance-guard.sql), que segue
-- existindo para chamada manual e para os testes -- numa transação só, com a
-- mesma lógica por conta (plan_maintenance_account). Re-rodar o guard ou a
-- central depois deste DESFAZ a correção E na função; re-rodar
-- plan-limits-cron.sql volta o job para a função (A volta). Este vai por
-- último.
--
-- PRÉ-REQUISITOS: pg_cron habilitado, plan-limits-central.sql e
-- plan-maintenance-guard.sql já rodados.
--
-- RODAR À MÃO A VERSÃO COM COMMIT: sozinha, numa execução própria do SQL
-- Editor (num script com outros comandos o Postgres não deixa a procedure
-- dar COMMIT):
--   call public.run_plan_maintenance_job('manual');
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

do $verifica$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') and to_regclass('cron.job') is null then
    raise exception 'PG_CRON_INDISPONIVEL: habilite em Database > Extensions > pg_cron e rode este arquivo de novo.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'plan_maintenance_accounts') then
    raise exception 'FALTA_GUARD: rode supabase/plan-maintenance-guard.sql antes deste arquivo.';
  end if;
end
$verifica$;

drop table if exists _pmp_relatorio;
drop table if exists _pmp_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES
-- --------------------------------------------------------------------------
create temp table _pmp_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.suppliers)           as suppliers,
  (select count(*) from public.products)            as products,
  (select count(*) from public.product_images)      as product_images,
  (select count(*) from public.supplier_images)     as supplier_images,
  (select count(*) from public.subscriptions)       as subscriptions,
  (select count(*) from public.subscription_events) as subscription_events,
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s) as hash_suppliers,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p) as hash_products,
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i) as hash_product_images,
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g) as hash_supplier_images,
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b) as hash_subscriptions;


-- --------------------------------------------------------------------------
-- 1) LOG POR EXECUÇÃO (D)
-- --------------------------------------------------------------------------
create table if not exists public.plan_maintenance_runs (
  id bigint generated always as identity primary key,
  source text not null,                 -- cron | manual | function
  status text not null check (status in ('running', 'done', 'skipped', 'aborted')),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  accounts int,                         -- contas varridas
  clean int,                            -- sem nada a fazer: nem travadas
  locked int,                           -- passaram pelo sync completo
  changed int,                          -- a central mudou anúncios/produtos
  failed_sync int,
  failed_limits int,
  note text
);

create index if not exists plan_maintenance_runs_started_at_idx on public.plan_maintenance_runs (started_at);

alter table public.plan_maintenance_runs enable row level security;
revoke all on table public.plan_maintenance_runs from public, anon, authenticated;


-- --------------------------------------------------------------------------
-- 2) "PRECISA DE ALGO?" -- só leitura, sem trava (E)
-- --------------------------------------------------------------------------

-- Mesmas condições dos passos (a)-(c) de advance_subscription_state.
create or replace function public.subscription_transition_pending(p_uid uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1 from public.subscriptions
    where created_by = p_uid
      and ((status in ('active', 'cancelled') and expires_at <= now())
           or (status = 'scheduled' and started_at <= now())));
$function$;

-- Quantas mudanças um resultado da central (ou da prévia) contém.
create or replace function public.plan_limits_change_count(p_result jsonb)
 returns integer
 language sql
 immutable
as $function$
  select coalesce((p_result->'ads'->>'restored')::int, 0)
       + coalesce((p_result->'ads'->>'suspended')::int, 0)
       + coalesce((p_result->'ads'->>'reason_changed')::int, 0)
       + coalesce((p_result->'ads'->>'legacy_unpaused')::int, 0)
       + coalesce((p_result->'products'->>'restored')::int, 0)
       + coalesce((p_result->'products'->>'suspended')::int, 0)
       + coalesce((p_result->'products'->>'reason_changed')::int, 0)
       + coalesce((p_result->'products'->>'legacy_unpaused')::int, 0);
$function$;


-- --------------------------------------------------------------------------
-- 3) UMA CONTA -- usada pela procedure e pela função
--
-- Devolve {"outcome": clean | unchanged | changed | failed_limits |
-- failed_sync}. Nunca levanta exceção: o erro fica num sub-bloco que desfaz
-- só esta conta (mesmo tratamento do guard).
-- --------------------------------------------------------------------------
create or replace function public.plan_maintenance_account(p_uid uuid, p_context text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ret jsonb;
begin
  begin
    if not public.subscription_transition_pending(p_uid)
       and public.plan_limits_change_count(public.preview_plan_limits(p_uid)) = 0 then
      return jsonb_build_object('outcome', 'clean');
    end if;

    v_ret := public.sync_subscription_for(p_uid, p_context);

    -- apply_plan_limits_safe não levanta exceção: devolve {"failed": true}
    -- e já gravou o evento plan_limits_failed.
    if coalesce((v_ret->>'failed')::boolean, false) then
      return jsonb_build_object('outcome', 'failed_limits');
    elsif public.plan_limits_change_count(v_ret) > 0 then
      return jsonb_build_object('outcome', 'changed');
    end if;
    return jsonb_build_object('outcome', 'unchanged');
  exception when others then
    raise warning 'run_plan_maintenance: conta % falhou: % [%]', p_uid, sqlerrm, sqlstate;
    begin
      insert into public.subscription_events (created_by, event_type, metadata)
      values (p_uid, 'plan_limits_failed',
              jsonb_build_object('context', p_context, 'sqlstate', sqlstate,
                                 'message', sqlerrm, 'at', now()));
    exception when others then
      raise warning 'nao foi possivel registrar a falha da conta %: %', p_uid, sqlerrm;
    end;
    return jsonb_build_object('outcome', 'failed_sync', 'message', sqlerrm);
  end;
end;
$function$;


-- --------------------------------------------------------------------------
-- 4) A PROCEDURE DO AGENDADOR (A) -- commit por conta
-- --------------------------------------------------------------------------

-- A trava global está presa por ESTA sessão? (pg_locks mostra uma linha por
-- trava, por mais vezes que a sessão a tenha pegado.)
create or replace function public.maintenance_lock_held_by_me()
 returns boolean
 language sql
 volatile
as $function$
  select exists (
    select 1 from pg_catalog.pg_locks
    where locktype = 'advisory' and pid = pg_catalog.pg_backend_pid() and objsubid = 1
      and classid::bigint = ((pg_catalog.hashtext('nexar:maintenance')::bigint >> 32) & 4294967295)
      and objid::bigint   = (pg_catalog.hashtext('nexar:maintenance')::bigint & 4294967295));
$function$;

create or replace procedure public.run_plan_maintenance_job(p_source text default 'cron')
 language plpgsql
as $procedure$
declare
  v_key bigint := pg_catalog.hashtext('nexar:maintenance');
  v_run bigint;
  v_uids uuid[];
  v_uid uuid;
  v_out text;
  v_clean int := 0;
  v_locked int := 0;
  v_changed int := 0;
  v_failed_sync int := 0;
  v_failed_limits int := 0;
begin
  -- COMMIT antes de tudo: chamada num contexto que não permite commit
  -- (dentro de BEGIN, ou num script com outros comandos) falha AQUI, com
  -- "invalid transaction termination", antes de pegar a trava de sessão --
  -- senão a trava ficaria presa naquela sessão e o job sairia 'skipped'
  -- até ela fechar.
  commit;

  -- Trava de SESSÃO: os commits abaixo não a soltam. Se esta sessão já a
  -- segura (execução manual anterior que morreu no meio), segue com ela.
  if not public.maintenance_lock_held_by_me() and not pg_catalog.pg_try_advisory_lock(v_key) then
    insert into public.plan_maintenance_runs (source, status, finished_at, note)
    values (p_source, 'skipped', clock_timestamp(), 'maintenance_in_progress');
    commit;
    return;
  end if;

  -- Quem segura a trava global é a única execução viva: qualquer 'running'
  -- que sobrou é de uma execução que morreu.
  update public.plan_maintenance_runs
  set status = 'aborted', finished_at = clock_timestamp()
  where status = 'running';

  insert into public.plan_maintenance_runs (source, status)
  values (p_source, 'running')
  returning id into v_run;

  select coalesce(array_agg(u order by u), '{}') into v_uids
  from public.plan_maintenance_accounts() u;
  commit;

  foreach v_uid in array v_uids loop
    v_out := public.plan_maintenance_account(v_uid, 'run_plan_maintenance')->>'outcome';
    commit;   -- solta as travas desta conta
    case v_out
      when 'clean' then v_clean := v_clean + 1;
      when 'changed' then v_locked := v_locked + 1; v_changed := v_changed + 1;
      when 'unchanged' then v_locked := v_locked + 1;
      when 'failed_limits' then v_locked := v_locked + 1; v_failed_limits := v_failed_limits + 1;
      else v_failed_sync := v_failed_sync + 1;
    end case;
  end loop;

  update public.plan_maintenance_runs
  set status = 'done', finished_at = clock_timestamp(),
      accounts = cardinality(v_uids), clean = v_clean, locked = v_locked, changed = v_changed,
      failed_sync = v_failed_sync, failed_limits = v_failed_limits
  where id = v_run;
  commit;

  while public.maintenance_lock_held_by_me() loop
    perform pg_catalog.pg_advisory_unlock(v_key);
  end loop;
end;
$procedure$;


-- --------------------------------------------------------------------------
-- 5) A FUNÇÃO -- numa transação só (manual/testes); mesma lógica por conta
-- --------------------------------------------------------------------------
create or replace function public.run_plan_maintenance()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid;
  v_out text;
  v_run bigint;
  v_total int := 0;
  v_clean int := 0;
  v_locked int := 0;
  v_changed int := 0;
  v_failed_sync int := 0;
  v_failed_limits int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('nexar:maintenance')) then
    insert into public.plan_maintenance_runs (source, status, finished_at, note)
    values ('function', 'skipped', clock_timestamp(), 'maintenance_in_progress');
    return jsonb_build_object(
      'accounts', 0, 'clean', 0, 'locked', 0, 'failed', 0, 'failed_sync', 0, 'failed_limits', 0,
      'changed', 0, 'skipped', true, 'reason', 'maintenance_in_progress', 'at', now());
  end if;

  update public.plan_maintenance_runs
  set status = 'aborted', finished_at = clock_timestamp()
  where status = 'running';

  for v_uid in select public.plan_maintenance_accounts() loop
    v_total := v_total + 1;
    v_out := public.plan_maintenance_account(v_uid, 'run_plan_maintenance')->>'outcome';
    case v_out
      when 'clean' then v_clean := v_clean + 1;
      when 'changed' then v_locked := v_locked + 1; v_changed := v_changed + 1;
      when 'unchanged' then v_locked := v_locked + 1;
      when 'failed_limits' then v_locked := v_locked + 1; v_failed_limits := v_failed_limits + 1;
      else v_failed_sync := v_failed_sync + 1;
    end case;
  end loop;

  insert into public.plan_maintenance_runs
    (source, status, finished_at, accounts, clean, locked, changed, failed_sync, failed_limits)
  values ('function', 'done', clock_timestamp(), v_total, v_clean, v_locked, v_changed, v_failed_sync, v_failed_limits)
  returning id into v_run;

  return jsonb_build_object(
    'accounts', v_total,
    'clean', v_clean,
    'locked', v_locked,
    'failed_sync', v_failed_sync,
    'failed_limits', v_failed_limits,
    'failed', v_failed_sync + v_failed_limits,
    'changed', v_changed,
    'skipped', false,
    'run_id', v_run,
    'at', now());
end;
$function$;


-- --------------------------------------------------------------------------
-- 6) LIMPEZA DO HISTÓRICO (F)
-- --------------------------------------------------------------------------
create or replace function public.prune_maintenance_history()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cron int := 0;
  v_runs int;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$delete from cron.job_run_details
               where coalesce(end_time, start_time) < now() - interval '7 days'$q$;
    get diagnostics v_cron = row_count;
  end if;

  delete from public.plan_maintenance_runs where started_at < now() - interval '30 days';
  get diagnostics v_runs = row_count;

  return jsonb_build_object('cron_job_run_details', v_cron, 'plan_maintenance_runs', v_runs, 'at', now());
end;
$function$;


-- --------------------------------------------------------------------------
-- 7) GRANTS -- nada disto é do cliente
-- --------------------------------------------------------------------------
revoke execute on function public.subscription_transition_pending(uuid) from public, anon, authenticated;
revoke execute on function public.plan_limits_change_count(jsonb) from public, anon, authenticated;
revoke execute on function public.plan_maintenance_account(uuid, text) from public, anon, authenticated;
revoke execute on function public.maintenance_lock_held_by_me() from public, anon, authenticated;
revoke execute on procedure public.run_plan_maintenance_job(text) from public, anon, authenticated;
revoke execute on function public.run_plan_maintenance() from public, anon, authenticated;
revoke execute on function public.prune_maintenance_history() from public, anon, authenticated;


-- --------------------------------------------------------------------------
-- 8) JOBS DO pg_cron
-- --------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job
where jobname in ('nexar-plan-maintenance', 'nexar-maintenance-prune');

select cron.schedule('nexar-plan-maintenance', '*/10 * * * *',
                     $job$call public.run_plan_maintenance_job()$job$);
select cron.schedule('nexar-maintenance-prune', '17 6 * * *',
                     $job$select public.prune_maintenance_history()$job$);


-- --------------------------------------------------------------------------
-- 9) FOTOGRAFIA DEPOIS + COMPARAÇÃO -- nenhum dado pode ter mudado.
-- --------------------------------------------------------------------------
insert into _pmp_foto
select
  'depois',
  (select count(*) from public.suppliers),
  (select count(*) from public.products),
  (select count(*) from public.product_images),
  (select count(*) from public.supplier_images),
  (select count(*) from public.subscriptions),
  (select count(*) from public.subscription_events),
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s),
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p),
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i),
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g),
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b);

do $confere$
declare
  a _pmp_foto;
  d _pmp_foto;
begin
  select * into a from _pmp_foto where momento = 'antes';
  select * into d from _pmp_foto where momento = 'depois';
  if (a.suppliers, a.products, a.product_images, a.supplier_images, a.subscriptions, a.subscription_events,
      a.hash_suppliers, a.hash_products, a.hash_product_images, a.hash_supplier_images, a.hash_subscriptions)
     is distinct from
     (d.suppliers, d.products, d.product_images, d.supplier_images, d.subscriptions, d.subscription_events,
      d.hash_suppliers, d.hash_products, d.hash_product_images, d.hash_supplier_images, d.hash_subscriptions)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%', to_jsonb(a), to_jsonb(d);
  end if;
end
$confere$;

create temp table _pmp_relatorio as select * from _pmp_foto;

commit;

notify pgrst, 'reload schema';


-- ==========================================================================
-- 10) TESTES -- NADA FICA GRAVADO
--
-- Cada teste roda num sub-bloco que termina SEMPRE em exceção: o Postgres
-- desfaz escritas, eventos, linhas de log e trocas de função.
--
-- A PROCEDURE não roda aqui: COMMIT dentro de um bloco com tratamento de
-- exceção é proibido. Commit por conta, trava de sessão, 'aborted' e
-- statement_timeout foram testados num Postgres local com várias conexões
-- (Resumo.md seção 192); no banco real, conferir plan_maintenance_runs
-- depois da primeira passada do job.
-- ==========================================================================

create temp table _pmp_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_j jsonb;
  v_res text;
  v_esp text;
  v_n int;
  v_need int;
  v_alvo uuid;
  v_sub uuid;
  v_id bigint;
  v_xmax_antes text;
  v_xmax_depois text;
  v_limpas uuid[];
begin
  select count(*) into v_n from public.plan_maintenance_accounts();
  select u into v_alvo from public.plan_maintenance_accounts() u limit 1;
  select count(*) into v_need from public.plan_maintenance_accounts() u
  where public.subscription_transition_pending(u)
     or public.plan_limits_change_count(public.preview_plan_limits(u)) > 0;

  -- 1) manutenção normal + linha de log
  begin
    v_j := public.run_plan_maintenance();
    select format('OK:skipped=%s accounts=%s clean=%s locked=%s failed=%s log=%s',
             v_j->>'skipped', v_j->>'accounts', v_j->>'clean', v_j->>'locked', v_j->>'failed',
             (select status || '/' || accounts || '/' || clean from public.plan_maintenance_runs
               where id = (v_j->>'run_id')::bigint))
      into v_res;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  v_esp := format('OK:skipped=false accounts=%s clean=%s locked=%s failed=0 log=done/%s/%s',
                  v_n, v_n - v_need, v_need, v_n, v_n - v_need);
  insert into _pmp_testes values ('1. manutenção normal + log', v_esp, v_res, v_res = v_esp);

  -- 2) contas sem nada a mudar não são travadas: o xmax das linhas candidatas
  --    não muda (for update grava o xid da transação no xmax).
  select coalesce(array_agg(u), '{}') into v_limpas from public.plan_maintenance_accounts() u
  where not public.subscription_transition_pending(u)
    and public.plan_limits_change_count(public.preview_plan_limits(u)) = 0;
  begin
    select md5(coalesce(string_agg(t, '|' order by t), '')) into v_xmax_antes from (
      select 's' || id || xmax::text t from public.suppliers
       where status in ('active', 'suspended') and created_by = any(v_limpas)
      union all
      select 'p' || id || xmax::text from public.products
       where status in ('active', 'suspended') and created_by = any(v_limpas)) x;
    perform public.run_plan_maintenance();
    select md5(coalesce(string_agg(t, '|' order by t), '')) into v_xmax_depois from (
      select 's' || id || xmax::text t from public.suppliers
       where status in ('active', 'suspended') and created_by = any(v_limpas)
      union all
      select 'p' || id || xmax::text from public.products
       where status in ('active', 'suspended') and created_by = any(v_limpas)) x;
    raise exception 'FIM:%', (v_xmax_antes = v_xmax_depois)::text;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmp_testes values ('2. conta limpa: nenhuma linha travada (xmax igual)', 'true', v_res, v_res = 'true');

  -- 3) transição pendente simulada: a conta passa pelo sync completo
  select created_by, id into v_alvo, v_sub from public.subscriptions
  where status in ('active', 'cancelled') order by created_by limit 1;
  if v_sub is null then
    insert into _pmp_testes values ('3. transição pendente', '-', 'sem assinatura ativa para simular', null);
  else
    begin
      update public.subscriptions set expires_at = now() - interval '1 second' where id = v_sub;
      v_j := public.run_plan_maintenance();
      select format('OK:locked>=1=%s failed=%s assinatura=%s',
               ((v_j->>'locked')::int >= 1)::text, v_j->>'failed',
               (select status from public.subscriptions where id = v_sub))
        into v_res;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _pmp_testes values ('3. transição pendente -> sync completo',
      'OK:locked>=1=true failed=0 assinatura=expired', v_res,
      v_res = 'OK:locked>=1=true failed=0 assinatura=expired');
  end if;

  -- 4/5) falhas simuladas. A conta alvo é forçada a "precisar de algo" (stub
  --      de subscription_transition_pending), senão seria 'clean' e nem
  --      chegaria à central.
  select u into v_alvo from public.plan_maintenance_accounts() u limit 1;
  begin
    alter function public.subscription_transition_pending(uuid) rename to stp_original_teste;
    execute format($f$
      create function public.subscription_transition_pending(p_uid uuid)
       returns boolean language sql stable set search_path to 'public' as $b$
        select p_uid = %L::uuid or public.stp_original_teste(p_uid) $b$ $f$, v_alvo);
    alter function public.apply_plan_limits(uuid, text) rename to apply_plan_limits_original_teste;
    execute format($f$
      create function public.apply_plan_limits(p_uid uuid, p_context text default null)
       returns jsonb language plpgsql security definer set search_path to 'public' as $b$
      begin
        if p_uid = %L::uuid then raise exception 'FALHA_SIMULADA_CENTRAL'; end if;
        return public.apply_plan_limits_original_teste(p_uid, p_context);
      end $b$ $f$, v_alvo);
    v_j := public.run_plan_maintenance();
    select format('OK:accounts=%s failed_limits=%s failed_sync=%s evento=%s',
             v_j->>'accounts', v_j->>'failed_limits', v_j->>'failed_sync',
             (select metadata->>'message' from public.subscription_events
               where created_by = v_alvo and event_type = 'plan_limits_failed'
               order by created_at desc limit 1))
      into v_res;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  v_esp := format('OK:accounts=%s failed_limits=1 failed_sync=0 evento=FALHA_SIMULADA_CENTRAL', v_n);
  insert into _pmp_testes values ('4. falha da central numa conta', v_esp, v_res, v_res = v_esp);

  begin
    alter function public.subscription_transition_pending(uuid) rename to stp_original_teste;
    execute format($f$
      create function public.subscription_transition_pending(p_uid uuid)
       returns boolean language sql stable set search_path to 'public' as $b$
        select p_uid = %L::uuid or public.stp_original_teste(p_uid) $b$ $f$, v_alvo);
    alter function public.advance_subscription_state(uuid) rename to advance_subscription_state_original_teste;
    execute format($f$
      create function public.advance_subscription_state(p_uid uuid)
       returns void language plpgsql security definer set search_path to 'public' as $b$
      begin
        if p_uid = %L::uuid then raise exception 'FALHA_SIMULADA_SYNC'; end if;
        perform public.advance_subscription_state_original_teste(p_uid);
      end $b$ $f$, v_alvo);
    v_j := public.run_plan_maintenance();
    select format('OK:accounts=%s failed_sync=%s failed_limits=%s evento=%s',
             v_j->>'accounts', v_j->>'failed_sync', v_j->>'failed_limits',
             (select metadata->>'message' from public.subscription_events
               where created_by = v_alvo and event_type = 'plan_limits_failed'
               order by created_at desc limit 1))
      into v_res;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  v_esp := format('OK:accounts=%s failed_sync=1 failed_limits=0 evento=FALHA_SIMULADA_SYNC', v_n);
  insert into _pmp_testes values ('5. falha de sincronização numa conta', v_esp, v_res, v_res = v_esp);

  insert into _pmp_testes values
    ('4/5. funções originais de volta', '0 cópias de teste',
     (select count(*) from pg_proc where proname like '%original_teste')::text || ' cópias de teste',
     not exists (select 1 from pg_proc where proname like '%original_teste'));

  -- 6) execução morta ('running' esquecido) vira 'aborted' na próxima
  begin
    insert into public.plan_maintenance_runs (source, status, started_at)
    values ('teste', 'running', now() - interval '1 hour') returning id into v_id;
    perform public.run_plan_maintenance();
    raise exception 'FIM:%', (select status from public.plan_maintenance_runs where id = v_id);
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmp_testes values ('6. running esquecido -> aborted', 'aborted', v_res, v_res = 'aborted');

  -- 7) limpeza: só o que passou do prazo
  begin
    insert into public.plan_maintenance_runs (source, status, started_at) values
      ('teste', 'done', now() - interval '31 days'),
      ('teste', 'done', now() - interval '29 days');
    v_j := public.prune_maintenance_history();
    raise exception 'FIM:%', format('apagou>=1=%s ficou_29d=%s cron_antigo=%s',
      ((v_j->>'plan_maintenance_runs')::int >= 1)::text,
      (select count(*) from public.plan_maintenance_runs where source = 'teste'),
      (select count(*) from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '7 days'));
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmp_testes values ('7. limpeza (30 dias / 7 dias)', 'apagou>=1=true ficou_29d=1 cron_antigo=0', v_res,
    v_res = 'apagou>=1=true ficou_29d=1 cron_antigo=0');

  -- 8) a procedure pode dar COMMIT: nem security definer nem SET
  insert into _pmp_testes
  select '8. procedure sem security definer e sem SET', 'false / -',
         prosecdef::text || ' / ' || coalesce(array_to_string(proconfig, ','), '-'),
         not prosecdef and proconfig is null
  from pg_proc where proname = 'run_plan_maintenance_job' and prokind = 'p';

  -- 9) segurança
  insert into _pmp_testes
  select '9. ' || r || ' executa ' || f, 'false',
         has_function_privilege(r, f, 'EXECUTE')::text, not has_function_privilege(r, f, 'EXECUTE')
  from unnest(array['anon', 'authenticated']) r,
       unnest(array['public.run_plan_maintenance_job(text)', 'public.run_plan_maintenance()',
                    'public.plan_maintenance_account(uuid, text)', 'public.prune_maintenance_history()',
                    'public.subscription_transition_pending(uuid)']) f;
  insert into _pmp_testes
  select '9. ' || r || ' lê plan_maintenance_runs', 'false',
         has_table_privilege(r, 'public.plan_maintenance_runs', 'SELECT')::text,
         not has_table_privilege(r, 'public.plan_maintenance_runs', 'SELECT')
  from unnest(array['anon', 'authenticated']) r;

  -- 10) jobs
  insert into _pmp_testes
  select '10. jobs do pg_cron',
         'nexar-maintenance-prune 17 6 * * * select public.prune_maintenance_history() | nexar-plan-maintenance */10 * * * * call public.run_plan_maintenance_job()',
         string_agg(jobname || ' ' || schedule || ' ' || command, ' | ' order by jobname),
         string_agg(jobname || ' ' || schedule || ' ' || command, ' | ' order by jobname)
           = 'nexar-maintenance-prune 17 6 * * * select public.prune_maintenance_history() | nexar-plan-maintenance */10 * * * * call public.run_plan_maintenance_job()'
  from cron.job where jobname like 'nexar-%';

  -- 11) regressão
  insert into _pmp_testes
  select '11. plan_product_limit / plan_ad_limit intactos', '5 / 1',
         public.plan_product_limit('basico') || ' / ' || public.plan_ad_limit('basico'),
         public.plan_product_limit('basico') = 5 and public.plan_ad_limit('basico') = 1;
end
$testes$;


-- ==========================================================================
-- 11) RESULTADO
-- ==========================================================================
select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s eventos=%s',
              suppliers, products, product_images, supplier_images, subscriptions, subscription_events) as esperado,
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left(hash_suppliers, 8), left(hash_products, 8), left(hash_product_images, 8),
              left(hash_supplier_images, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _pmp_relatorio
union all
select teste, esperado, obtido, ok from _pmp_testes
union all
select 'contagem agora (pós-testes)',
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s eventos=%s',
              (select count(*) from public.suppliers), (select count(*) from public.products),
              (select count(*) from public.product_images), (select count(*) from public.supplier_images),
              (select count(*) from public.subscriptions), (select count(*) from public.subscription_events)),
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left((select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s), 8),
              left((select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p), 8),
              left((select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i), 8),
              left((select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g), 8),
              left((select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b), 8)),
       null
from (select 1) x
-- linhas de log desta migration: nenhuma (os testes desfazem as suas)
union all
select 'linhas em plan_maintenance_runs (fora do job)', '-',
       (select count(*) from public.plan_maintenance_runs where source <> 'cron')::text, null;
