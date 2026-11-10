-- ==========================================================================
-- MANUTENÇÃO DE PLANOS -- trava global, ordem fixa e contagem de falhas
--
-- Corrige os problemas B e C da auditoria do agendador (Resumo.md seções
-- 188-190). Os problemas A, D, E e F NÃO são tratados aqui.
--
-- B) CONCORRÊNCIA DA MANUTENÇÃO
--    * Trava GLOBAL `nexar:maintenance` (pg_try_advisory_xact_lock): se outra
--      manutenção estiver rodando, esta sai NA HORA, sem erro, sem tocar em
--      conta nenhuma, devolvendo skipped=true. Não espera.
--    * Ordem FIXA das contas (order by uid). Antes a ordem era a do hash do
--      UNION, e duas varreduras simultâneas podiam travar contas em ordem
--      cruzada (deadlock). A SELEÇÃO de contas é exatamente a de antes --
--      só passou para plan_maintenance_accounts() para ser testável.
--    * As travas POR CONTA (conta/anúncios/produtos) continuam iguais.
--
-- C) FALHAS DA CENTRAL NO CONTADOR
--    Antes o retorno de sync_subscription_for era descartado, e uma falha da
--    central (capturada por apply_plan_limits_safe, que devolve
--    {"failed": true}) não entrava em `failed`. Agora:
--      failed_sync    erro que escapou de sync_subscription_for (assinatura)
--                     -- a conta inteira volta, como antes;
--      failed_limits  a central falhou (a transição de assinatura da conta
--                     fica; só a central volta -- regra da etapa 3);
--      changed        contas em que a central alterou anúncios/produtos;
--      failed         = failed_sync + failed_limits (compatibilidade com o
--                     campo que já existia);
--      skipped        true quando outra manutenção estava rodando.
--    Eventos plan_limits_failed e WARNINGs continuam como antes.
--
-- SUBSTITUI run_plan_maintenance (de plan-limits-central.sql). Re-rodar
-- aquele arquivo depois deste DESFAZ esta correção -- este vai por último.
-- O job do pg_cron não muda: continua `select public.run_plan_maintenance()`,
-- a cada 10 minutos.
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

drop table if exists _pmg_relatorio;
drop table if exists _pmg_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES
-- --------------------------------------------------------------------------
create temp table _pmg_foto on commit drop as
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
-- 1) CONTAS DA MANUTENÇÃO -- mesma seleção de antes, agora em ordem fixa
-- --------------------------------------------------------------------------
create or replace function public.plan_maintenance_accounts()
 returns setof uuid
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select x.uid
  from (
    select created_by as uid from public.subscriptions where created_by is not null
    union
    select created_by from public.suppliers where created_by is not null and status in ('active', 'suspended')
    union
    select created_by from public.products where created_by is not null and status in ('active', 'suspended')
  ) x
  order by x.uid;
$function$;


-- --------------------------------------------------------------------------
-- 2) A MANUTENÇÃO
-- --------------------------------------------------------------------------
create or replace function public.run_plan_maintenance()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid;
  v_ret jsonb;
  v_total int := 0;
  v_failed_sync int := 0;
  v_failed_limits int := 0;
  v_changed int := 0;
begin
  -- Trava GLOBAL. try: se outra manutenção está rodando, sai já -- esperar
  -- só faria as duas processarem as mesmas contas em sequência.
  -- Transacional: solta sozinha no fim desta execução.
  if not pg_try_advisory_xact_lock(hashtext('nexar:maintenance')) then
    return jsonb_build_object(
      'accounts', 0, 'failed', 0, 'failed_sync', 0, 'failed_limits', 0, 'changed', 0,
      'skipped', true, 'reason', 'maintenance_in_progress', 'at', now());
  end if;

  for v_uid in select public.plan_maintenance_accounts() loop
    v_total := v_total + 1;
    begin
      v_ret := public.sync_subscription_for(v_uid, 'run_plan_maintenance');

      -- apply_plan_limits_safe não levanta exceção: devolve {"failed": true}
      -- e já gravou o evento plan_limits_failed. Aqui só se CONTA.
      if coalesce((v_ret->>'failed')::boolean, false) then
        v_failed_limits := v_failed_limits + 1;
      elsif coalesce((v_ret->'ads'->>'restored')::int, 0) + coalesce((v_ret->'ads'->>'suspended')::int, 0)
          + coalesce((v_ret->'ads'->>'reason_changed')::int, 0) + coalesce((v_ret->'ads'->>'legacy_unpaused')::int, 0)
          + coalesce((v_ret->'products'->>'restored')::int, 0) + coalesce((v_ret->'products'->>'suspended')::int, 0)
          + coalesce((v_ret->'products'->>'reason_changed')::int, 0) > 0 then
        v_changed := v_changed + 1;
      end if;
    exception when others then
      -- Erro que escapou do sync (ex.: na transição da assinatura): o
      -- sub-bloco desfaz SÓ esta conta. Mesmo tratamento de antes.
      v_failed_sync := v_failed_sync + 1;
      raise warning 'run_plan_maintenance: conta % falhou: % [%]', v_uid, sqlerrm, sqlstate;
      begin
        insert into public.subscription_events (created_by, event_type, metadata)
        values (v_uid, 'plan_limits_failed',
                jsonb_build_object('context', 'run_plan_maintenance', 'sqlstate', sqlstate,
                                   'message', sqlerrm, 'at', now()));
      exception when others then
        raise warning 'nao foi possivel registrar a falha da conta %: %', v_uid, sqlerrm;
      end;
    end;
  end loop;

  return jsonb_build_object(
    'accounts', v_total,
    'failed_sync', v_failed_sync,
    'failed_limits', v_failed_limits,
    'failed', v_failed_sync + v_failed_limits,
    'changed', v_changed,
    'skipped', false,
    'at', now());
end;
$function$;

revoke execute on function public.plan_maintenance_accounts() from public, anon, authenticated;
revoke execute on function public.run_plan_maintenance() from public, anon, authenticated;


-- --------------------------------------------------------------------------
-- 3) FOTOGRAFIA DEPOIS + COMPARAÇÃO -- nenhum dado pode ter mudado.
-- --------------------------------------------------------------------------
insert into _pmg_foto
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
  a _pmg_foto;
  d _pmg_foto;
begin
  select * into a from _pmg_foto where momento = 'antes';
  select * into d from _pmg_foto where momento = 'depois';
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

create temp table _pmg_relatorio as select * from _pmg_foto;

commit;

notify pgrst, 'reload schema';


-- ==========================================================================
-- 4) TESTES -- NADA FICA GRAVADO
--
-- Cada teste roda num sub-bloco que termina SEMPRE em exceção: o Postgres
-- desfaz escritas, eventos, notificações e até as trocas de função (DDL é
-- transacional).
--
-- O teste "outra manutenção em andamento -> skipped" PRECISA de duas
-- conexões (na mesma sessão a trava é reentrante) e por isso não roda aqui:
-- foi feito num Postgres local com duas conexões (Resumo.md seção 190).
-- ==========================================================================

create temp table _pmg_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_j jsonb;
  v_res text;
  v_n int;
  v_alvo uuid;
  v_ordem1 text;
  v_ordem2 text;
  v_ordem3 text;
begin
  select count(*) into v_n from public.plan_maintenance_accounts();
  select u into v_alvo from public.plan_maintenance_accounts() u limit 1;  -- min(uuid) não existe no PG do Supabase

  -- 1) manutenção normal
  begin
    v_j := public.run_plan_maintenance();
    v_res := format('OK:skipped=%s accounts=%s failed_sync=%s failed_limits=%s failed=%s',
                    v_j->>'skipped', v_j->>'accounts', v_j->>'failed_sync', v_j->>'failed_limits', v_j->>'failed');
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmg_testes values ('1. manutenção normal',
    format('OK:skipped=false accounts=%s failed_sync=0 failed_limits=0 failed=0', v_n), v_res,
    v_res = format('OK:skipped=false accounts=%s failed_sync=0 failed_limits=0 failed=0', v_n));

  -- 3) ordem determinística
  select string_agg(u::text, ',') into v_ordem1 from public.plan_maintenance_accounts() u;
  select string_agg(u::text, ',') into v_ordem2 from public.plan_maintenance_accounts() u;
  select string_agg(u::text, ',') into v_ordem3 from public.plan_maintenance_accounts() u;
  insert into _pmg_testes values ('3. ordem igual em 3 consultas e crescente', 'true',
    ((v_ordem1 = v_ordem2 and v_ordem2 = v_ordem3)
     and v_ordem1 = (select string_agg(u::text, ',' order by u) from public.plan_maintenance_accounts() u))::text,
    (v_ordem1 = v_ordem2 and v_ordem2 = v_ordem3)
     and v_ordem1 = (select string_agg(u::text, ',' order by u) from public.plan_maintenance_accounts() u));
  insert into _pmg_testes values ('3. mesma seleção de contas de antes', '-', v_n || ' contas', null);

  -- 4) falha simulada da CENTRAL só na primeira conta: apply_plan_limits
  --    passa a estourar para ela e a chamar a original para as demais.
  begin
    alter function public.apply_plan_limits(uuid, text) rename to apply_plan_limits_original_teste;
    execute format($f$
      create function public.apply_plan_limits(p_uid uuid, p_context text default null)
       returns jsonb language plpgsql security definer set search_path to 'public' as $b$
      begin
        if p_uid = %L::uuid then raise exception 'FALHA_SIMULADA_CENTRAL'; end if;
        return public.apply_plan_limits_original_teste(p_uid, p_context);
      end $b$ $f$, v_alvo);
    v_j := public.run_plan_maintenance();
    select format('OK:accounts=%s failed_limits=%s failed_sync=%s failed=%s evento=%s',
             v_j->>'accounts', v_j->>'failed_limits', v_j->>'failed_sync', v_j->>'failed',
             (select metadata->>'message' from public.subscription_events
               where created_by = v_alvo and event_type = 'plan_limits_failed'
               order by created_at desc limit 1))
      into v_res;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmg_testes values ('4. falha da central numa conta',
    format('OK:accounts=%s failed_limits=1 failed_sync=0 failed=1 evento=FALHA_SIMULADA_CENTRAL', v_n), v_res,
    v_res = format('OK:accounts=%s failed_limits=1 failed_sync=0 failed=1 evento=FALHA_SIMULADA_CENTRAL', v_n));

  -- 5) falha de SINCRONIZAÇÃO só na primeira conta: advance_subscription_
  --    state estoura para ela.
  begin
    alter function public.advance_subscription_state(uuid) rename to advance_subscription_state_original_teste;
    execute format($f$
      create function public.advance_subscription_state(p_uid uuid)
       returns void language plpgsql security definer set search_path to 'public' as $b$
      begin
        if p_uid = %L::uuid then raise exception 'FALHA_SIMULADA_SYNC'; end if;
        perform public.advance_subscription_state_original_teste(p_uid);
      end $b$ $f$, v_alvo);
    v_j := public.run_plan_maintenance();
    select format('OK:accounts=%s failed_sync=%s failed_limits=%s failed=%s evento=%s',
             v_j->>'accounts', v_j->>'failed_sync', v_j->>'failed_limits', v_j->>'failed',
             (select metadata->>'message' from public.subscription_events
               where created_by = v_alvo and event_type = 'plan_limits_failed'
               order by created_at desc limit 1))
      into v_res;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _pmg_testes values ('5. falha de sincronização numa conta',
    format('OK:accounts=%s failed_sync=1 failed_limits=0 failed=1 evento=FALHA_SIMULADA_SYNC', v_n), v_res,
    v_res = format('OK:accounts=%s failed_sync=1 failed_limits=0 failed=1 evento=FALHA_SIMULADA_SYNC', v_n));

  -- funções de volta ao normal depois dos testes 4 e 5
  insert into _pmg_testes values
    ('4/5. apply_plan_limits e advance_subscription_state originais', '0 cópias de teste',
     (select count(*) from pg_proc where proname in ('apply_plan_limits_original_teste', 'advance_subscription_state_original_teste'))::text || ' cópias de teste',
     not exists (select 1 from pg_proc where proname in ('apply_plan_limits_original_teste', 'advance_subscription_state_original_teste')));

  -- 6) segurança
  insert into _pmg_testes values
    ('6. anon executa run_plan_maintenance', 'false',
      has_function_privilege('anon', 'public.run_plan_maintenance()', 'EXECUTE')::text,
      not has_function_privilege('anon', 'public.run_plan_maintenance()', 'EXECUTE')),
    ('6. authenticated executa run_plan_maintenance', 'false',
      has_function_privilege('authenticated', 'public.run_plan_maintenance()', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.run_plan_maintenance()', 'EXECUTE')),
    ('6. authenticated executa plan_maintenance_accounts', 'false',
      has_function_privilege('authenticated', 'public.plan_maintenance_accounts()', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.plan_maintenance_accounts()', 'EXECUTE')),
    ('6. anon executa plan_maintenance_accounts', 'false',
      has_function_privilege('anon', 'public.plan_maintenance_accounts()', 'EXECUTE')::text,
      not has_function_privilege('anon', 'public.plan_maintenance_accounts()', 'EXECUTE'));

  -- 7) regressão
  insert into _pmg_testes
  select '7. plan_product_limit / plan_ad_limit intactos', '5 / 1',
         public.plan_product_limit('basico') || ' / ' || public.plan_ad_limit('basico'),
         public.plan_product_limit('basico') = 5 and public.plan_ad_limit('basico') = 1;
  insert into _pmg_testes
  select '7. job do pg_cron', '1 job, */10, select public.run_plan_maintenance()',
         count(*) || ' job, ' || coalesce(min(schedule), '-') || ', ' || coalesce(min(command), '-'),
         count(*) = 1 and min(schedule) = '*/10 * * * *' and min(command) = 'select public.run_plan_maintenance()'
  from cron.job where command ilike '%run_plan_maintenance%';
end
$testes$;


-- ==========================================================================
-- 5) RESULTADO
-- ==========================================================================
select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s eventos=%s',
              suppliers, products, product_images, supplier_images, subscriptions, subscription_events) as esperado,
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left(hash_suppliers, 8), left(hash_products, 8), left(hash_product_images, 8),
              left(hash_supplier_images, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _pmg_relatorio
union all
select teste, esperado, obtido, ok from _pmg_testes
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
       null;
