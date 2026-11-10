-- ==========================================================================
-- LIMITES DE PLANO -- o que o fornecedor vê e escolhe
--
-- Resumo.md seção 194. Itens deixados para depois na seção 184:
--
-- 1. NOTIFICAÇÃO quando o sistema tira algo do ar ou devolve ao ar.
--    Trigger em subscription_events: cada 'plan_limits_applied' (gravado
--    pela central só quando algo muda) vira uma notificação, SE algum item
--    saiu ou voltou ao ar. Mudança só de motivo (no_plan <-> plan_limit) não
--    notifica sozinha -- decisão do usuário. Uma falha aqui nunca derruba a
--    central (exceção capturada, WARNING no log).
--
-- 2. PRÉVIA da troca de plano / cancelamento: preview_my_plan_change(plano)
--    -- plano NULL = ficar sem plano (cancelamento). Só leitura. Devolve, para
--    anúncios e produtos, quais SAEM e quais VOLTAM ao ar, com nome, pela
--    mesma regra da central (plan_limit_projection reproduz a ordem de
--    fit_items_to_plan_limit; um teste abaixo confere as duas para toda conta
--    e todo plano).
--
-- 3. ESCOLHA MANUAL: swap_plan_slot('ad'|'product', suspenso, ativo) põe no
--    ar um item suspenso pelo limite do plano no lugar de um ativo, numa
--    operação só -- o número de ativos não muda, o limite nunca é passado. A
--    central respeita a escolha depois: ela mantém primeiro quem já está
--    ativo. Só para motivo 'plan_limit' (sem plano não há vaga para trocar).
--    Grava 'plan_slot_swapped' em subscription_events (sem notificação: foi
--    o próprio fornecedor).
--
-- 4. Limite TOTAL de produtos: o usuário decidiu MANTER igual ao de ativos
--    (plan_product_total_limit continua devolvendo plan_product_limit). Nada
--    muda no banco por isso.
--
-- ADITIVO: nenhuma função existente é substituída. Roda depois de
-- plan-limits-central.sql (usa lock_plan_account, plan_ad_limit,
-- plan_product_limit, fornecedor_current_plan_id).
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

do $verifica$
begin
  if not exists (select 1 from pg_proc where proname = 'apply_plan_limits') then
    raise exception 'FALTA_CENTRAL: rode supabase/plan-limits-central.sql antes deste arquivo.';
  end if;
end
$verifica$;

drop table if exists _plux_relatorio;
drop table if exists _plux_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES
-- --------------------------------------------------------------------------
create temp table _plux_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.suppliers)           as suppliers,
  (select count(*) from public.products)            as products,
  (select count(*) from public.subscriptions)       as subscriptions,
  (select count(*) from public.subscription_events) as subscription_events,
  (select count(*) from public.notifications)       as notifications,
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s) as hash_suppliers,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p) as hash_products,
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b) as hash_subscriptions;


-- --------------------------------------------------------------------------
-- 1) NOTIFICAÇÃO
-- --------------------------------------------------------------------------

-- "1 anúncio", "2 anúncios e 1 produto", "3 produtos".
create or replace function public.plan_items_phrase(p_ads integer, p_products integer)
 returns text
 language sql
 immutable
as $function$
  select concat_ws(' e ',
    case when p_ads = 1 then '1 anúncio' when p_ads > 1 then p_ads || ' anúncios' end,
    case when p_products = 1 then '1 produto' when p_products > 1 then p_products || ' produtos' end);
$function$;

create or replace function public.notify_plan_limits_applied()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ads_s int := coalesce((new.metadata->'ads'->>'suspended')::int, 0);
  v_ads_r int := coalesce((new.metadata->'ads'->>'restored')::int, 0);
  v_prod_s int := coalesce((new.metadata->'products'->>'suspended')::int, 0);
  v_prod_r int := coalesce((new.metadata->'products'->>'restored')::int, 0);
  v_plan text := new.metadata->>'plan';
  v_partes text[] := '{}';
  v_tipo text;
  v_titulo text;
begin
  if v_ads_s + v_ads_r + v_prod_s + v_prod_r = 0 then
    return null;
  end if;

  begin
    if v_ads_s + v_prod_s > 0 then
      v_partes := v_partes || (
        public.plan_items_phrase(v_ads_s, v_prod_s)
        || case when v_ads_s + v_prod_s = 1 then ' saiu do ar ' else ' saíram do ar ' end
        || case when v_plan is null then 'porque sua conta está sem plano ativo.'
                else 'pelo limite do plano '
                     || case v_plan when 'basico' then 'Básico' when 'profissional' then 'Profissional'
                                    when 'premium' then 'Premium' else v_plan end || '.' end);
    end if;
    if v_ads_r + v_prod_r > 0 then
      v_partes := v_partes || (
        public.plan_items_phrase(v_ads_r, v_prod_r)
        || case when v_ads_r + v_prod_r = 1 then ' voltou ao ar.' else ' voltaram ao ar.' end);
    end if;
    if v_ads_s + v_prod_s > 0 then
      v_partes := v_partes || 'Nada foi apagado.'::text;
      if v_plan is not null then
        v_partes := v_partes || 'No painel você pode escolher quais ficam no ar.'::text;
      end if;
    end if;

    if v_ads_r + v_prod_r = 0 then
      v_tipo := 'plan_limits_suspended';
      v_titulo := 'Itens fora do ar';
    elsif v_ads_s + v_prod_s = 0 then
      v_tipo := 'plan_limits_restored';
      v_titulo := 'Itens de volta ao ar';
    else
      v_tipo := 'plan_limits_adjusted';
      v_titulo := 'Seus itens foram ajustados ao plano';
    end if;

    insert into public.notifications (created_by, type, title, body, link, metadata)
    values (new.created_by, v_tipo, v_titulo, array_to_string(v_partes, ' '),
            case when v_ads_s + v_ads_r > 0 then '/Dashboard' else '/Catalogo' end,
            jsonb_build_object('event_id', new.id, 'plan', v_plan,
                               'ads_suspended', v_ads_s, 'ads_restored', v_ads_r,
                               'products_suspended', v_prod_s, 'products_restored', v_prod_r));
  exception when others then
    -- A notificação é aviso, não regra: nunca desfaz o ajuste da central.
    raise warning 'notify_plan_limits_applied: conta %: % [%]', new.created_by, sqlerrm, sqlstate;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_notify_plan_limits on public.subscription_events;
create trigger trg_notify_plan_limits
after insert on public.subscription_events
for each row
when (new.event_type = 'plan_limits_applied')
execute function public.notify_plan_limits_applied();


-- --------------------------------------------------------------------------
-- 2) PRÉVIA
-- --------------------------------------------------------------------------

-- O que a central faria numa tabela com este limite, item a item. MESMA
-- ordem de fit_items_to_plan_limit (ativos primeiro, created_at, id) -- se
-- uma mudar, a outra tem de mudar junto (teste 4 abaixo confere). Anúncio
-- legado suspenso-de-pausado (status_before_suspension='paused') fica de
-- fora: a central o devolve a pausado antes de contar.
create or replace function public.plan_limit_projection(p_table text, p_uid uuid, p_limit integer)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_result jsonb;
begin
  if p_table not in ('suppliers', 'products') then
    raise exception 'INVALID_TABLE: %', p_table;
  end if;

  execute format($q$
    with c as (
      select id, %s as name, status, created_at
      from public.%I
      where created_by = $1 and status in ('active', 'suspended') %s
    ),
    k as (
      select id from c
      order by (status = 'active') desc, created_at asc nulls last, id asc
      limit $2
    )
    select jsonb_build_object(
      'limit', case when $2 >= 2147483647 then null else $2 end,
      'active_now', (select count(*) from c where status = 'active'),
      'active_after', (select count(*) from k),
      'suspend', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by created_at desc nulls first, id desc)
                           from c where status = 'active' and id not in (select id from k)), '[]'::jsonb),
      'restore', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by created_at asc nulls last, id asc)
                           from c where status = 'suspended' and id in (select id from k)), '[]'::jsonb))
    $q$,
    case p_table when 'suppliers' then 'business_name' else 'name' end,
    p_table,
    case p_table when 'suppliers'
      then $x$and not (status = 'suspended' and status_before_suspension is not distinct from 'paused')$x$
      else '' end)
  into v_result
  using p_uid, greatest(coalesce(p_limit, 0), 0);

  return v_result;
end;
$function$;

-- Para a tela: o que muda nos MEUS anúncios e produtos se eu passar a ter
-- `p_plan_id` (NULL = sem plano). Calculado pelo estado de agora; num
-- downgrade, que só vale no dia 10, o estado pode mudar até lá.
create or replace function public.preview_my_plan_change(p_plan_id text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_plan_id is not null and p_plan_id not in ('basico', 'profissional', 'premium') then
    raise exception 'INVALID_PLAN: %', p_plan_id;
  end if;

  return jsonb_build_object(
    'plan', p_plan_id,
    'current_plan', public.fornecedor_current_plan_id(v_uid),
    'ads', public.plan_limit_projection('suppliers', v_uid, public.plan_ad_limit(p_plan_id)),
    'products', public.plan_limit_projection('products', v_uid, public.plan_product_limit(p_plan_id)));
end;
$function$;


-- --------------------------------------------------------------------------
-- 3) ESCOLHA MANUAL -- trocar um ativo por um suspenso pelo limite
-- --------------------------------------------------------------------------
create or replace function public.swap_plan_slot(p_kind text, p_activate uuid, p_suspend uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_table text;
  v_found int;
  v_act_status text;
  v_act_reason text;
  v_sus_status text;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  v_table := case p_kind when 'ad' then 'suppliers' when 'product' then 'products' end;
  if v_table is null then
    raise exception 'INVALID_KIND: %', p_kind;
  end if;
  if p_activate is null or p_suspend is null or p_activate = p_suspend then
    raise exception 'SWAP_INVALID: escolha um item suspenso e um item ativo diferentes.';
  end if;

  -- Mesma ordem de travas da central: conta -> linhas (por id) -> chave de
  -- contagem. Ver o cabeçalho de plan-limits-central.sql.
  perform public.lock_plan_account(v_uid);

  execute format('select count(*) from (select 1 from public.%I where id in ($1, $2) and created_by = $3 order by id for update) x', v_table)
    into v_found using p_activate, p_suspend, v_uid;
  if v_found <> 2 then
    raise exception 'SWAP_NOT_FOUND: item nao encontrado.';
  end if;

  execute format('select status, suspension_reason from public.%I where id = $1', v_table)
    into v_act_status, v_act_reason using p_activate;
  execute format('select status from public.%I where id = $1', v_table)
    into v_sus_status using p_suspend;

  if v_act_status <> 'suspended' or v_act_reason is distinct from 'plan_limit' then
    raise exception 'SWAP_NOT_PLAN_LIMIT: so um item suspenso pelo limite do plano pode entrar no lugar de outro.';
  end if;
  if v_sus_status <> 'active' then
    raise exception 'SWAP_NOT_ACTIVE: o item que sai precisa estar ativo.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    case v_table when 'suppliers' then 'nexar:ads:' else 'nexar:products:' end || v_uid::text, 0));

  -- Primeiro tira um do ar, depois põe o outro: em nenhum momento há mais
  -- ativos que antes.
  execute format(
    'update public.%I set status = ''suspended'', suspension_reason = ''plan_limit'', suspended_at = now()%s where id = $1',
    v_table, case v_table when 'suppliers' then ', status_before_suspension = ''active''' else '' end)
  using p_suspend;
  execute format(
    'update public.%I set status = ''active'', suspension_reason = null, suspended_at = null%s where id = $1',
    v_table, case v_table when 'suppliers' then ', status_before_suspension = null' else '' end)
  using p_activate;

  insert into public.subscription_events (created_by, event_type, metadata)
  values (v_uid, 'plan_slot_swapped',
          jsonb_build_object('kind', p_kind, 'activated', p_activate, 'suspended', p_suspend, 'at', now()));

  return jsonb_build_object('kind', p_kind, 'activated', p_activate, 'suspended', p_suspend);
end;
$function$;


-- --------------------------------------------------------------------------
-- 4) GRANTS
-- --------------------------------------------------------------------------
revoke execute on function public.plan_items_phrase(integer, integer) from public, anon, authenticated;
revoke execute on function public.notify_plan_limits_applied() from public, anon, authenticated;
revoke execute on function public.plan_limit_projection(text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.preview_my_plan_change(text) from public, anon;
revoke execute on function public.swap_plan_slot(text, uuid, uuid) from public, anon;
grant execute on function public.preview_my_plan_change(text) to authenticated;
grant execute on function public.swap_plan_slot(text, uuid, uuid) to authenticated;


-- --------------------------------------------------------------------------
-- 5) FOTOGRAFIA DEPOIS + COMPARAÇÃO -- nenhum dado pode ter mudado.
-- --------------------------------------------------------------------------
insert into _plux_foto
select
  'depois',
  (select count(*) from public.suppliers),
  (select count(*) from public.products),
  (select count(*) from public.subscriptions),
  (select count(*) from public.subscription_events),
  (select count(*) from public.notifications),
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s),
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p),
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b);

do $confere$
declare
  a _plux_foto;
  d _plux_foto;
begin
  select * into a from _plux_foto where momento = 'antes';
  select * into d from _plux_foto where momento = 'depois';
  if (a.suppliers, a.products, a.subscriptions, a.subscription_events, a.notifications,
      a.hash_suppliers, a.hash_products, a.hash_subscriptions)
     is distinct from
     (d.suppliers, d.products, d.subscriptions, d.subscription_events, d.notifications,
      d.hash_suppliers, d.hash_products, d.hash_subscriptions)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%', to_jsonb(a), to_jsonb(d);
  end if;
end
$confere$;

create temp table _plux_relatorio as select * from _plux_foto;

commit;

notify pgrst, 'reload schema';


-- ==========================================================================
-- 6) TESTES -- NADA FICA GRAVADO (cada sub-bloco termina em exceção)
-- ==========================================================================

create temp table _plux_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_res text;
  v_esp text;
  v_uid uuid;
  v_j jsonb;
  v_a uuid;
  v_b uuid;
  v_n int;
  v_div int := 0;
  v_plan text;
begin
  -- 1) frases
  insert into _plux_testes values ('1. frase de quantidades',
    '1 anúncio | 2 anúncios e 1 produto | 3 produtos',
    concat_ws(' | ', public.plan_items_phrase(1, 0), public.plan_items_phrase(2, 1), public.plan_items_phrase(0, 3)),
    concat_ws(' | ', public.plan_items_phrase(1, 0), public.plan_items_phrase(2, 1), public.plan_items_phrase(0, 3))
      = '1 anúncio | 2 anúncios e 1 produto | 3 produtos');

  -- 2) notificação: suspensão de anúncios + produtos sob o Básico
  select created_by into v_uid from public.suppliers where status = 'active'
  group by created_by order by count(*) desc, created_by limit 1;
  begin
    insert into public.subscription_events (created_by, event_type, to_plan, metadata)
    values (v_uid, 'plan_limits_applied', 'basico',
            '{"plan":"basico","ads":{"suspended":2,"restored":0},"products":{"suspended":1,"restored":0}}');
    select format('%s | %s | %s | %s', type, title, body, link) into v_res
    from public.notifications where created_by = v_uid order by created_at desc limit 1;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  v_esp := 'plan_limits_suspended | Itens fora do ar | 2 anúncios e 1 produto saíram do ar pelo limite do plano Básico. Nada foi apagado. No painel você pode escolher quais ficam no ar. | /Dashboard';
  insert into _plux_testes values ('2. notificação de suspensão', v_esp, v_res, v_res = v_esp);

  -- 3) notificação: restauração; e mudança só de motivo NÃO notifica
  begin
    select count(*) into v_n from public.notifications where created_by = v_uid;
    insert into public.subscription_events (created_by, event_type, to_plan, metadata)
    values (v_uid, 'plan_limits_applied', null,
            '{"plan":null,"ads":{"suspended":0,"restored":0,"reason_changed":3},"products":{"suspended":0,"restored":0}}');
    insert into public.subscription_events (created_by, event_type, to_plan, metadata)
    values (v_uid, 'plan_limits_applied', 'premium',
            '{"plan":"premium","ads":{"suspended":0,"restored":0},"products":{"suspended":0,"restored":1}}');
    select format('novas=%s | %s | %s | %s', (select count(*) from public.notifications where created_by = v_uid) - v_n,
                  type, body, link) into v_res
    from public.notifications where created_by = v_uid order by created_at desc limit 1;
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  v_esp := 'novas=1 | plan_limits_restored | 1 produto voltou ao ar. | /Catalogo';
  insert into _plux_testes values ('3. restauração notifica; só motivo não', v_esp, v_res, v_res = v_esp);

  -- 4) a prévia segue a MESMA regra da central: para toda conta e todo
  --    plano, as quantidades batem com fit_items_to_plan_limit em modo prévia.
  for v_uid in select public.plan_maintenance_accounts() loop
    foreach v_plan in array array['', 'basico', 'profissional', 'premium'] loop
      if (select jsonb_array_length(p->'suspend') <> (f->>'suspended')::int
                 or jsonb_array_length(p->'restore') <> (f->>'restored')::int
          from (select public.plan_limit_projection('suppliers', v_uid, public.plan_ad_limit(nullif(v_plan, ''))) p,
                       public.fit_items_to_plan_limit('suppliers', v_uid, public.plan_ad_limit(nullif(v_plan, '')),
                         case when v_plan = '' then 'no_plan' else 'plan_limit' end, true) f) x)
         or (select jsonb_array_length(p->'suspend') <> (f->>'suspended')::int
                 or jsonb_array_length(p->'restore') <> (f->>'restored')::int
          from (select public.plan_limit_projection('products', v_uid, public.plan_product_limit(nullif(v_plan, ''))) p,
                       public.fit_items_to_plan_limit('products', v_uid, public.plan_product_limit(nullif(v_plan, '')),
                         case when v_plan = '' then 'no_plan' else 'plan_limit' end, true) f) x)
      then
        v_div := v_div + 1;
      end if;
    end loop;
  end loop;
  insert into _plux_testes values ('4. prévia = central (contas x 4 planos)', '0 divergências',
    v_div || ' divergências', v_div = 0);

  -- 5) prévia como o dono, num downgrade simulado para o Básico
  select created_by into v_uid from public.suppliers where status = 'active'
  group by created_by having count(*) >= 2 order by count(*) desc, created_by limit 1;
  if v_uid is null then
    insert into _plux_testes values ('5. prévia do dono', '-', 'nenhuma conta com 2+ anúncios ativos', null);
  else
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      v_j := public.preview_my_plan_change('basico');
      raise exception 'FIM:%', format('ativos_depois=%s sai=%s',
        v_j->'ads'->>'active_after', jsonb_array_length(v_j->'ads'->'suspend'));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    v_esp := format('ativos_depois=1 sai=%s',
      (select count(*) - 1 from public.suppliers where created_by = v_uid and status = 'active'));
    insert into _plux_testes values ('5. prévia do dono (Básico)', v_esp, v_res, v_res = v_esp);

    -- 6) troca: um ativo sai, um suspenso pelo limite entra
    begin
      perform set_config('request.jwt.claims', '', true);
      update public.suppliers set status = 'suspended', suspension_reason = 'plan_limit',
             status_before_suspension = 'active', suspended_at = now()
      where id = (select id from public.suppliers where created_by = v_uid and status = 'active'
                  order by created_at desc, id desc limit 1)
      returning id into v_a;
      select id into v_b from public.suppliers where created_by = v_uid and status = 'active'
      order by created_at, id limit 1;
      select count(*) into v_n from public.suppliers where created_by = v_uid and status = 'active';
      perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      perform public.swap_plan_slot('ad', v_a, v_b);
      perform set_config('request.jwt.claims', '', true);
      raise exception 'FIM:%', format('entrou=%s saiu=%s/%s ativos_iguais=%s evento=%s',
        (select status from public.suppliers where id = v_a),
        (select status from public.suppliers where id = v_b),
        (select suspension_reason from public.suppliers where id = v_b),
        ((select count(*) from public.suppliers where created_by = v_uid and status = 'active') = v_n)::text,
        (select count(*) from public.subscription_events where created_by = v_uid and event_type = 'plan_slot_swapped'
           and metadata->>'activated' = v_a::text));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    v_esp := 'entrou=active saiu=suspended/plan_limit ativos_iguais=true evento=1';
    insert into _plux_testes values ('6. troca ativo <-> suspenso', v_esp, v_res, v_res = v_esp);

    -- 7) troca recusada: item que não está suspenso pelo limite
    begin
      select id into v_a from public.suppliers where created_by = v_uid and status = 'active' order by id limit 1;
      select id into v_b from public.suppliers where created_by = v_uid and status = 'active' and id <> v_a order by id limit 1;
      perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      perform public.swap_plan_slot('ad', v_a, v_b);
      raise exception 'FIM:passou';
    exception when others then v_res := split_part(replace(sqlerrm, 'FIM:', ''), ':', 1);
    end;
    insert into _plux_testes values ('7. ativo no lugar de ativo -> recusado', 'SWAP_NOT_PLAN_LIMIT', v_res, v_res = 'SWAP_NOT_PLAN_LIMIT');

    -- 8) troca recusada: item de OUTRA conta
    begin
      select id into v_a from public.suppliers where created_by <> v_uid order by id limit 1;
      perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      perform public.swap_plan_slot('ad', v_a, v_b);
      raise exception 'FIM:passou';
    exception when others then v_res := split_part(replace(sqlerrm, 'FIM:', ''), ':', 1);
    end;
    insert into _plux_testes values ('8. item de outra conta -> recusado', 'SWAP_NOT_FOUND', v_res,
      v_res = 'SWAP_NOT_FOUND' or v_a is null);
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- 9) sem login
  begin
    v_j := public.preview_my_plan_change('basico');
    raise exception 'FIM:passou';
  exception when others then v_res := split_part(replace(sqlerrm, 'FIM:', ''), ':', 1);
  end;
  insert into _plux_testes values ('9. prévia sem login', 'AUTH_REQUIRED', v_res, v_res = 'AUTH_REQUIRED');

  -- 10) grants
  insert into _plux_testes
  select '10. ' || r || ' executa ' || f, esp::text,
         has_function_privilege(r, f, 'EXECUTE')::text, has_function_privilege(r, f, 'EXECUTE') = esp
  from (values
    ('anon', 'public.preview_my_plan_change(text)', false),
    ('anon', 'public.swap_plan_slot(text, uuid, uuid)', false),
    ('authenticated', 'public.preview_my_plan_change(text)', true),
    ('authenticated', 'public.swap_plan_slot(text, uuid, uuid)', true),
    ('authenticated', 'public.plan_limit_projection(text, uuid, integer)', false),
    ('authenticated', 'public.notify_plan_limits_applied()', false)) t(r, f, esp);

  -- 11) regressão
  insert into _plux_testes
  select '11. limites intactos (anúncios / produtos / total do Básico)', '1 / 5 / 5',
         public.plan_ad_limit('basico') || ' / ' || public.plan_product_limit('basico') || ' / ' || public.plan_product_total_limit('basico'),
         public.plan_ad_limit('basico') = 1 and public.plan_product_limit('basico') = 5 and public.plan_product_total_limit('basico') = 5;
end
$testes$;


-- ==========================================================================
-- 7) RESULTADO
-- ==========================================================================
select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s subscriptions=%s eventos=%s notificações=%s',
              suppliers, products, subscriptions, subscription_events, notifications) as esperado,
       format('hash sup=%s prod=%s sub=%s', left(hash_suppliers, 8), left(hash_products, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _plux_relatorio
union all
select teste, esperado, obtido, ok from _plux_testes
union all
select 'contagem agora (pós-testes)',
       format('suppliers=%s products=%s subscriptions=%s eventos=%s notificações=%s',
              (select count(*) from public.suppliers), (select count(*) from public.products),
              (select count(*) from public.subscriptions), (select count(*) from public.subscription_events),
              (select count(*) from public.notifications)),
       format('hash sup=%s prod=%s sub=%s',
              left((select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s), 8),
              left((select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p), 8),
              left((select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b), 8)),
       null;
