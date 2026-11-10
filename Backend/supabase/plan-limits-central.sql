-- *** 2026-11-03 (C1, Resumo.md §231-232): o subscribe_to_plan deste arquivo
-- ganhou a guarda PAYMENT_REQUIRED (só o Básico). A versão VIVA é a de
-- fix-paid-plan-activation.sql; se re-rodar este arquivo, rode depois
-- plan-limits-central.sql e fix-paid-plan-activation.sql (nessa ordem).
-- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
-- recusa assinatura paga sem pagamento aprovado mesmo assim. ***
-- ==========================================================================
-- LIMITES DE PLANO -- ETAPA 3: FUNÇÃO CENTRAL + VISIBILIDADE DE PRODUTOS
--
-- Resumo.md seções 184-185. Roda DEPOIS de plan-limits-hardening.sql.
--
-- O QUE ENTRA
--   1. apply_plan_limits(uid): UMA regra para anúncios e produtos. Calcula o
--      estado desejado e só altera o que diverge (idempotente):
--        * candidatos = itens 'active' e 'suspended'. 'paused' NUNCA é tocado;
--        * ficam ativos os primeiros `limite` na ordem
--            1. atualmente ativos  2. created_at crescente  3. id crescente;
--        * o resto fica 'suspended' com o motivo da CAUSA ATUAL:
--            sem plano -> 'no_plan'; com plano -> 'plan_limit'.
--      Registra o resultado em subscription_events ('plan_limits_applied')
--      quando algo muda -- é o insumo das notificações futuras.
--   2. apply_plan_limits_safe(uid, contexto): chama a central num bloco
--      protegido. Se ela falhar, SÓ ela volta; quem chamou (a assinatura)
--      fica gravado, e o erro vai para subscription_events
--      ('plan_limits_failed') com sqlstate, mensagem, detalhe e contexto. O
--      próximo sync/manutenção tenta de novo.
--   3. subscribe_to_plan / sync_my_subscription / cancel_my_subscription /
--      reactivate_my_subscription: mesmos corpos de billing-cycle-day-10.sql,
--      com trava da conta no início e a central no lugar de
--      suspend_my_ads/restore_my_suspended_ads. CORRIGE o bug da seção 182:
--      assinar não falha mais porque há mais itens suspensos que o limite.
--      As quatro também põem a assinatura em dia com o relógio antes de
--      decidir (advance_subscription_state) -- CORRIGE um segundo bug,
--      achado no ensaio: plano vencido sem sync impedia assinar de novo
--      (índice único de 'active').
--   4. sync_subscription_for(uid) + run_plan_maintenance(): o mesmo sync, por
--      conta, chamável sem login -- para o agendador (plan-limits-cron.sql).
--   5. preview_plan_limits(uid): SÓ LEITURA, mesmo cálculo da central sem
--      gravar. Alimenta o relatório desta migration e a futura prévia em Planos.
--   6. Produtos: limite de ATIVOS (só status='active' conta), checagem na
--      ATIVAÇÃO (paused -> active), e limite TOTAL de cadastrados -- hoje com
--      os MESMOS números do limite de ativos (os valores oficiais não mudam;
--      ver plan_product_total_limit). Criar além do limite de ativos, dentro
--      do total, nasce 'paused'.
--   7. Visibilidade: produto e foto de produto só são públicos com
--      status='active'; o dono continua lendo os próprios. company_public_
--      products também filtra status='active'.
--   8. suspend_my_ads / restore_my_suspended_ads viram invólucros da central
--      e saem do alcance do cliente (revoke).
--   9. enforce_supplier_ad_rules passa a checar só o CLIENTE: o sistema é
--      governado pela central (foi a checagem no sistema que causou o bug).
--
-- O QUE NÃO ENTRA
--   * Nenhum dado é alterado por esta migration (autoverificação abaixo). A
--     central NÃO é rodada nas contas existentes aqui: o relatório mostra o
--     que ela faria; a aplicação vem com plan-limits-cron.sql.
--   * Notificações, escolha manual de item suspenso, fotos públicas por
--     plano, valores oficiais dos planos.
--
-- TRAVAS (ordem fixa, evita deadlock -- ver seção 185):
--   1. nexar:account:<uid>      (RPCs de assinatura e a central)
--   2. linhas candidatas de suppliers e products (for update, por id)
--   3. nexar:ads:<uid>          (também tomada pelo trigger do cliente)
--   4. nexar:products:<uid>     (idem)
--   A central trava as LINHAS antes das chaves de contagem porque o cliente
--   faz o inverso sem poder escolher (o Postgres trava a linha antes de rodar
--   o trigger BEFORE UPDATE): se a central segurasse a chave e depois
--   esperasse a linha, e o cliente segurasse a linha e esperasse a chave,
--   seria deadlock.
--
-- SUBSTITUI (re-rodar o arquivo antigo depois DESFAZ isto -- este vai por
-- último):
--   subscribe_to_plan, sync_my_subscription, cancel_my_subscription,
--   reactivate_my_subscription, suspend_my_ads, restore_my_suspended_ads,
--   company_public_products            (de billing-cycle-day-10.sql)
--   enforce_supplier_ad_rules          (de rls-policies.sql)
--   enforce_product_catalog_rules      (de product-catalog.sql)
--   policy "Public can read products"        (de rls-policies.sql)
--   policy "Public can read product images"  (de product-catalog.sql)
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

drop table if exists _plc_relatorio;
drop table if exists _plc_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES
-- --------------------------------------------------------------------------
create temp table _plc_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.suppliers)       as suppliers,
  (select count(*) from public.products)        as products,
  (select count(*) from public.product_images)  as product_images,
  (select count(*) from public.supplier_images) as supplier_images,
  (select count(*) from public.subscriptions)   as subscriptions,
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s) as hash_suppliers,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p) as hash_products,
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i) as hash_product_images,
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g) as hash_supplier_images,
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b) as hash_subscriptions;


-- --------------------------------------------------------------------------
-- 1) LIMITES E CONTAGENS DE PRODUTO
-- --------------------------------------------------------------------------

-- Limite TOTAL de produtos cadastrados (ativos + pausados + suspensos).
-- Existe para que "criar pausado" e "suspender o excedente" não virem
-- armazenamento ilimitado em plano menor. HOJE devolve exatamente o limite de
-- ativos: os valores oficiais não mudam nesta etapa (decisão do usuário,
-- seção 184). Enquanto os dois forem iguais, o comportamento de criação é o
-- de antes -- a proposta de valores próprios está na seção 185.
-- Mirror futuro: PLAN_PRODUCT_TOTAL_LIMITS em src/lib/plans.js.
create or replace function public.plan_product_total_limit(plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select public.plan_product_limit(plan_id);
$function$;

-- Produtos ATIVOS (os que contam no limite). Mesma chave de trava de
-- fornecedor_product_count: as duas contagens se serializam juntas.
create or replace function public.fornecedor_active_product_count(p_uid uuid)
 returns integer
 language plpgsql
 volatile
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('nexar:products:' || p_uid::text, 0));
  return (select count(*)::int from public.products p
          where p.created_by = p_uid and p.status = 'active');
end;
$function$;

-- fornecedor_product_count (plan-limits-hardening.sql) continua contando
-- TODOS os produtos: é a contagem do limite TOTAL.


-- --------------------------------------------------------------------------
-- 2) TRAVA DA CONTA
-- --------------------------------------------------------------------------
create or replace function public.lock_plan_account(p_uid uuid)
 returns void
 language sql
as $function$
  select pg_advisory_xact_lock(hashtextextended('nexar:account:' || p_uid::text, 0));
$function$;


-- --------------------------------------------------------------------------
-- 3) O NÚCLEO: ajustar UMA tabela ao limite
--
-- Uma função só para suppliers e products -- a regra não é duplicada. O
-- nome da tabela vem de uma lista fechada (nunca do cliente; a função nem é
-- chamável por ele).
--
-- p_dry_run = true: só calcula (preview). Não trava, não grava.
-- --------------------------------------------------------------------------
create or replace function public.fit_items_to_plan_limit(
  p_table text, p_uid uuid, p_limit integer, p_reason text, p_dry_run boolean default false
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_keep uuid[];
  v_extra_restore text := '';
  v_extra_suspend text := '';
  v_legacy int := 0;
  v_restore int;
  v_suspend int;
  v_reason int;
  v_active_before int;
  v_paused int;
begin
  if p_table not in ('suppliers', 'products') then
    raise exception 'INVALID_TABLE: %', p_table;
  end if;
  if p_reason not in ('no_plan', 'plan_limit') then
    raise exception 'INVALID_REASON: %', p_reason;
  end if;

  if p_table = 'suppliers' then
    -- status_before_suspension segue existindo por compatibilidade: todo
    -- item suspenso pela regra nova estava 'active'.
    v_extra_restore := ', status_before_suspension = null';
    v_extra_suspend := ', status_before_suspension = ''active''';

    -- LEGADO: suspend_my_ads antigo suspendia anúncios PAUSADOS, guardando
    -- 'paused'. Pela regra aprovada o sistema não mexe em pausados: esses
    -- voltam a ser pausados (continuam fora do site). Hoje são 0.
    if p_dry_run then
      select count(*) into v_legacy from public.suppliers
      where created_by = p_uid and status = 'suspended' and status_before_suspension = 'paused';
    else
      update public.suppliers
      set status = 'paused', status_before_suspension = null,
          suspended_at = null, suspension_reason = null
      where created_by = p_uid and status = 'suspended' and status_before_suspension = 'paused';
      get diagnostics v_legacy = row_count;
    end if;
  end if;

  -- Trava as LINHAS candidatas (ordem por id) ANTES da chave de contagem --
  -- ver o cabeçalho do arquivo.
  if not p_dry_run then
    execute format(
      'select 1 from public.%I where created_by = $1 and status in (''active'', ''suspended'') order by id for update',
      p_table) using p_uid;
    perform pg_advisory_xact_lock(hashtextextended(
      case p_table when 'suppliers' then 'nexar:ads:' else 'nexar:products:' end || p_uid::text, 0));
  end if;

  execute format(
    'select count(*) filter (where status = ''active''), count(*) filter (where status = ''paused'')
     from public.%I where created_by = $1', p_table)
  into v_active_before, v_paused using p_uid;

  -- A ORDEM APROVADA: ativos primeiro, depois os mais antigos, depois id.
  execute format(
    'select coalesce(array_agg(id), ''{}'') from (
       select id from public.%I
       where created_by = $1 and status in (''active'', ''suspended'')
       order by (status = ''active'') desc, created_at asc nulls last, id asc
       limit $2) k', p_table)
  into v_keep using p_uid, greatest(coalesce(p_limit, 0), 0);

  if p_dry_run then
    execute format('select count(*) from public.%I where created_by = $1 and status = ''suspended'' and id = any($2)', p_table)
      into v_restore using p_uid, v_keep;
    execute format('select count(*) from public.%I where created_by = $1 and status = ''active'' and not (id = any($2))', p_table)
      into v_suspend using p_uid, v_keep;
    execute format('select count(*) from public.%I where created_by = $1 and status = ''suspended'' and not (id = any($2)) and suspension_reason is distinct from $3', p_table)
      into v_reason using p_uid, v_keep, p_reason;
  else
    -- dentro do limite: volta a ficar ativo
    execute format(
      'update public.%I set status = ''active'', suspension_reason = null, suspended_at = null%s
       where created_by = $1 and status = ''suspended'' and id = any($2)', p_table, v_extra_restore)
    using p_uid, v_keep;
    get diagnostics v_restore = row_count;

    -- fora do limite e ativo: suspende com o motivo atual
    execute format(
      'update public.%I set status = ''suspended'', suspension_reason = $3, suspended_at = now()%s
       where created_by = $1 and status = ''active'' and not (id = any($2))', p_table, v_extra_suspend)
    using p_uid, v_keep, p_reason;
    get diagnostics v_suspend = row_count;

    -- já suspenso e continua fora: só acerta o motivo (no_plan <-> plan_limit).
    -- suspended_at é mantido: é quando ele saiu do ar, não quando o motivo mudou.
    execute format(
      'update public.%I set suspension_reason = $3
       where created_by = $1 and status = ''suspended'' and not (id = any($2))
         and suspension_reason is distinct from $3', p_table)
    using p_uid, v_keep, p_reason;
    get diagnostics v_reason = row_count;
  end if;

  return jsonb_build_object(
    'limit', case when p_limit >= 2147483647 then null else p_limit end,
    'active_before', v_active_before,
    'active_after', v_active_before + v_restore - v_suspend,
    'restored', v_restore,
    'suspended', v_suspend,
    'reason_changed', v_reason,
    'legacy_unpaused', v_legacy,
    'paused_untouched', v_paused + v_legacy,
    'reason', p_reason
  );
end;
$function$;


-- --------------------------------------------------------------------------
-- 4) A FUNÇÃO CENTRAL
-- --------------------------------------------------------------------------
create or replace function public.apply_plan_limits(p_uid uuid, p_context text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_plan text;
  v_reason text;
  v_ads jsonb;
  v_products jsonb;
  v_result jsonb;
begin
  if p_uid is null then
    raise exception 'ACCOUNT_REQUIRED';
  end if;

  perform public.lock_plan_account(p_uid);

  v_plan := public.fornecedor_current_plan_id(p_uid);
  v_reason := case when v_plan is null then 'no_plan' else 'plan_limit' end;

  v_ads      := public.fit_items_to_plan_limit('suppliers', p_uid, public.plan_ad_limit(v_plan), v_reason);
  v_products := public.fit_items_to_plan_limit('products',  p_uid, public.plan_product_limit(v_plan), v_reason);

  v_result := jsonb_build_object('plan', v_plan, 'context', p_context, 'ads', v_ads, 'products', v_products);

  -- Registro para as notificações futuras -- só quando algo mudou, para o
  -- agendador não encher o histórico a cada 10 minutos.
  if (v_ads->>'restored')::int + (v_ads->>'suspended')::int + (v_ads->>'reason_changed')::int
     + (v_ads->>'legacy_unpaused')::int
     + (v_products->>'restored')::int + (v_products->>'suspended')::int
     + (v_products->>'reason_changed')::int > 0 then
    insert into public.subscription_events (created_by, event_type, to_plan, metadata)
    values (p_uid, 'plan_limits_applied', v_plan, v_result);
  end if;

  return v_result;
end;
$function$;

-- Chamada protegida: a falha da central NUNCA derruba quem chamou.
create or replace function public.apply_plan_limits_safe(p_uid uuid, p_context text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_state text;
  v_msg text;
  v_detail text;
  v_hint text;
  v_ctx text;
  v_info jsonb;
begin
  begin
    return public.apply_plan_limits(p_uid, p_context);
  exception when others then
    get stacked diagnostics
      v_state  = returned_sqlstate,
      v_msg    = message_text,
      v_detail = pg_exception_detail,
      v_hint   = pg_exception_hint,
      v_ctx    = pg_exception_context;
    v_info := jsonb_build_object(
      'context', p_context, 'sqlstate', v_state, 'message', v_msg,
      'detail', v_detail, 'hint', v_hint, 'pg_context', v_ctx,
      'plan', public.fornecedor_current_plan_id(p_uid), 'at', now());
    -- WARNING aparece no log do Postgres; o evento fica consultável.
    raise warning 'apply_plan_limits falhou (conta %, %): % [%]', p_uid, p_context, v_msg, v_state;
    begin
      insert into public.subscription_events (created_by, event_type, metadata)
      values (p_uid, 'plan_limits_failed', v_info);
    exception when others then
      raise warning 'nao foi possivel registrar plan_limits_failed: %', sqlerrm;
    end;
    return jsonb_build_object('failed', true) || v_info;
  end;
end;
$function$;

-- Prévia: mesmo cálculo, nada gravado.
create or replace function public.preview_plan_limits(p_uid uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_plan text := public.fornecedor_current_plan_id(p_uid);
  v_reason text := case when public.fornecedor_current_plan_id(p_uid) is null then 'no_plan' else 'plan_limit' end;
begin
  return jsonb_build_object(
    'plan', v_plan,
    'ads', public.fit_items_to_plan_limit('suppliers', p_uid, public.plan_ad_limit(v_plan), v_reason, true),
    'products', public.fit_items_to_plan_limit('products', p_uid, public.plan_product_limit(v_plan), v_reason, true));
end;
$function$;


-- --------------------------------------------------------------------------
-- 5) INVÓLUCROS DE COMPATIBILIDADE -- fora do alcance do cliente
-- --------------------------------------------------------------------------
create or replace function public.suspend_my_ads()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    perform public.apply_plan_limits_safe(auth.uid(), 'suspend_my_ads');
  end if;
end;
$function$;

create or replace function public.restore_my_suspended_ads()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is not null then
    perform public.apply_plan_limits_safe(auth.uid(), 'restore_my_suspended_ads');
  end if;
end;
$function$;


-- --------------------------------------------------------------------------
-- 6) SYNC POR CONTA (para o agendador) + sync_my_subscription
--
-- Passos (a)-(c) idênticos aos de billing-cycle-day-10.sql. O (d), que
-- suspendia/restaurava, virou a central.
-- --------------------------------------------------------------------------
-- Passos (a)-(c): põem a ASSINATURA em dia com o relógio. Separados porque
-- subscribe_to_plan também precisa deles: sem isto, uma conta cujo plano
-- venceu sem ninguém rodar o sync (linha ainda 'active', expires_at no
-- passado) não conseguia assinar -- o insert do plano novo batia no índice
-- único de 'active' (bug pré-existente, achado no ensaio da seção 185).
create or replace function public.advance_subscription_state(p_uid uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- (a) encerra o que venceu -- libera o slot do índice único de 'active'
  update public.subscriptions
  set status = 'expired', next_charge_at = null
  where created_by = p_uid
    and status in ('active', 'cancelled')
    and expires_at <= now();

  -- (b) promove o agendamento cuja data chegou
  update public.subscriptions
  set status = 'active'
  where created_by = p_uid
    and status = 'scheduled'
    and started_at <= now();

  -- (c) se o promovido já nasceu vencido, encerra também
  update public.subscriptions
  set status = 'expired', next_charge_at = null
  where created_by = p_uid
    and status = 'active'
    and expires_at <= now();
end;
$function$;

create or replace function public.sync_subscription_for(p_uid uuid, p_context text default 'sync')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_uid is null then
    return null;
  end if;

  perform public.lock_plan_account(p_uid);
  perform public.advance_subscription_state(p_uid);

  -- (d) ajusta anúncios e produtos ao plano que sobrou (ou à falta dele)
  return public.apply_plan_limits_safe(p_uid, p_context);
end;
$function$;

create or replace function public.sync_my_subscription()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    return;
  end if;
  perform public.sync_subscription_for(auth.uid(), 'sync_my_subscription');
end;
$function$;

-- Manutenção de TODAS as contas -- o que o agendador chama. Cada conta numa
-- sub-transação: uma conta com problema não impede as outras.
--
-- Varre toda conta que tem assinatura, anúncio ou produto. Para cada uma, o
-- sync só grava quando há algo a mudar, então rodar a cada 10 minutos não
-- gera escrita nem evento à toa. Se o número de contas crescer muito, trocar
-- a varredura por um filtro de "transição pendente" -- hoje são poucas.
create or replace function public.run_plan_maintenance()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid;
  v_total int := 0;
  v_failed int := 0;
begin
  for v_uid in
    select created_by from public.subscriptions where created_by is not null
    union
    select created_by from public.suppliers where created_by is not null and status in ('active', 'suspended')
    union
    select created_by from public.products where created_by is not null and status in ('active', 'suspended')
  loop
    v_total := v_total + 1;
    begin
      perform public.sync_subscription_for(v_uid, 'run_plan_maintenance');
    exception when others then
      v_failed := v_failed + 1;
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
  return jsonb_build_object('accounts', v_total, 'failed', v_failed, 'at', now());
end;
$function$;


-- --------------------------------------------------------------------------
-- 7) subscribe_to_plan -- corpo de billing-cycle-day-10.sql, com:
--    * trava da conta no início;
--    * apply_plan_limits_safe no lugar de restore_my_suspended_ads.
-- --------------------------------------------------------------------------
create or replace function public.subscribe_to_plan(p_plan_id text)
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
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
  -- C1 (Resumo.md §231-232): plano pago NÃO se ativa por esta RPC -- só o
  -- backend, com pagamento aprovado (asaas-billing.sql). Acrescentado em
  -- 2026-11-03 também a esta versão antiga, para que re-rodar este arquivo
  -- não reabra a falha. O gatilho trg_guard_paid_subscription recusa a
  -- linha paga de qualquer forma.
  if p_plan_id is distinct from 'basico' then
    raise exception 'PAYMENT_REQUIRED'
      using hint = 'Planos pagos só são ativados depois de pagamento confirmado.';
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


-- --------------------------------------------------------------------------
-- 8) cancel_my_subscription -- corpo de billing-cycle-day-10.sql; no Básico
--    a central (sem plano -> no_plan) no lugar de suspend_my_ads.
-- --------------------------------------------------------------------------
create or replace function public.cancel_my_subscription()
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  perform public.lock_plan_account(v_uid);
  perform public.advance_subscription_state(v_uid);

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'active' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_ACTIVE_SUBSCRIPTION';
  end if;

  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  if v_row.plan_id = 'basico' then
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), expires_at = now(), next_charge_at = null
    where id = v_row.id
    returning * into v_row;

    perform public.apply_plan_limits_safe(v_uid, 'cancel_my_subscription:basico');
  else
    -- Pago: benefícios até o vencimento; a suspensão (no_plan) vem na
    -- virada, pelo agendador ou pelo sync.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), next_charge_at = null
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$function$;


-- --------------------------------------------------------------------------
-- 9) reactivate_my_subscription -- corpo de billing-cycle-day-10.sql
-- --------------------------------------------------------------------------
create or replace function public.reactivate_my_subscription()
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  perform public.lock_plan_account(v_uid);
  perform public.advance_subscription_state(v_uid);

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'cancelled' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_CANCELLED_SUBSCRIPTION';
  end if;

  update public.subscriptions
  set status = 'active',
      cancelled_at = null,
      next_charge_at = case when v_row.plan_id = 'basico' then null else v_row.expires_at end
  where id = v_row.id
  returning * into v_row;

  perform public.apply_plan_limits_safe(v_uid, 'reactivate_my_subscription');
  return v_row;
end;
$function$;


-- --------------------------------------------------------------------------
-- 10) TRIGGERS DE LIMITE -- só o cliente é checado
-- --------------------------------------------------------------------------

-- Corpo de rls-policies.sql; a única mudança é o desvio: antes só o admin
-- passava, agora quem não é cliente (admin incluso, via is_client_writer).
create or replace function public.enforce_supplier_ad_rules()
 returns trigger
 language plpgsql
as $function$
declare
  activating boolean;
begin
  if not public.is_client_writer() then
    return new;
  end if;

  if new.status is null then
    new.status := 'active';
  end if;

  if TG_OP = 'INSERT' then
    activating := (new.status = 'active');
  else
    activating := (new.status = 'active' and old.status is distinct from 'active');
  end if;

  if activating then
    if not public.fornecedor_has_active_plan(new.created_by) then
      raise exception 'PLAN_REQUIRED: voce precisa de um plano ativo para publicar anuncios.';
    end if;

    if public.fornecedor_active_ad_count(new.created_by)
       >= public.plan_ad_limit(public.fornecedor_current_plan_id(new.created_by)) then
      raise exception 'PLAN_LIMIT: voce atingiu o limite de anuncios do seu plano.';
    end if;
  end if;

  return new;
end;
$function$;

-- Produtos: TOTAL na criação; ATIVOS na criação e na ativação.
create or replace function public.enforce_product_catalog_rules()
 returns trigger
 language plpgsql
as $function$
declare
  v_plan text;
begin
  if not public.is_client_writer() then
    return new;
  end if;

  v_plan := public.fornecedor_current_plan_id(new.created_by);

  if TG_OP = 'INSERT' then
    if public.fornecedor_product_count(new.created_by)
       >= public.plan_product_total_limit(v_plan) then
      raise exception 'PLAN_LIMIT: voce atingiu o limite de produtos do catalogo no seu plano atual.';
    end if;

    -- Cabe no total mas não nos ativos: nasce pausado (não conta no limite).
    -- Com os valores atuais (total = ativos) este ramo não acontece.
    if new.status = 'active'
       and public.fornecedor_active_product_count(new.created_by)
           >= public.plan_product_limit(v_plan) then
      new.status := 'paused';
    end if;
  elsif new.status = 'active' and old.status is distinct from 'active' then
    if v_plan is null then
      raise exception 'PLAN_REQUIRED: voce precisa de um plano ativo para publicar produtos.';
    end if;
    if public.fornecedor_active_product_count(new.created_by)
       >= public.plan_product_limit(v_plan) then
      raise exception 'PLAN_LIMIT: voce atingiu o limite de produtos ativos do seu plano.';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_product_catalog_rules on public.products;
create trigger trg_enforce_product_catalog_rules
before insert or update on public.products
for each row execute function public.enforce_product_catalog_rules();


-- --------------------------------------------------------------------------
-- 11) VISIBILIDADE PÚBLICA DOS PRODUTOS
-- --------------------------------------------------------------------------
drop policy if exists "Public can read products" on public.products;
drop policy if exists "Public can read active products, owners read all their own" on public.products;
create policy "Public can read active products, owners read all their own"
on public.products
for select
to anon, authenticated
using (
  status = 'active'
  or auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Foto segue o produto. Dono lê as fotos dos próprios produtos em qualquer
-- status (o Catálogo mostra o produto pausado com foto).
drop policy if exists "Public can read product images" on public.product_images;
drop policy if exists "Public can read images of active products, owners read their own" on public.product_images;
create policy "Public can read images of active products, owners read their own"
on public.product_images
for select
to anon, authenticated
using (
  exists (
    select 1 from public.products p
    where p.id = product_id
      and (p.status = 'active' or p.created_by = auth.uid())
  )
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- company_public_products: corpo de billing-cycle-day-10.sql + status='active'.
-- Mesma assinatura (create or replace não pode mudar o row type).
create or replace function public.company_public_products(p_supplier_id uuid)
 returns table(
   id uuid,
   name text,
   description text,
   category text,
   price numeric,
   unit text,
   min_quantity integer,
   in_stock boolean,
   created_at timestamptz,
   images jsonb
 )
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    p.id,
    p.name::text,
    p.description::text,
    p.category::text,
    p.price::numeric,
    p.unit::text,
    p.min_quantity::integer,
    p.in_stock::boolean,
    p.created_at,
    coalesce(
      (select jsonb_agg(pi.url order by pi.position)
       from public.product_images pi
       where pi.product_id = p.id),
      '[]'::jsonb
    ) as images
  from public.products p
  where p.created_by = (
    select s1.created_by from public.suppliers s1 where s1.id = p_supplier_id
  )
  and p.status = 'active'
  and exists (
    select 1 from public.subscriptions sub
    where sub.created_by = p.created_by
      and sub.status in ('active', 'cancelled')
      and sub.started_at <= now()
      and sub.expires_at > now()
  )
  order by p.created_at desc nulls last;
$function$;


-- --------------------------------------------------------------------------
-- 12) GRANTS
--
-- `from public, anon, authenticated` -- o default do projeto dá EXECUTE
-- direto para anon/authenticated (seção 98).
-- company_public_products: só authenticated, como deixou anon-content-gate.
-- As funções chamadas DENTRO de triggers do cliente (contagens,
-- plan_product_total_limit) mantêm o EXECUTE padrão.
-- --------------------------------------------------------------------------
revoke execute on function public.lock_plan_account(uuid) from public, anon, authenticated;
revoke execute on function public.fit_items_to_plan_limit(text, uuid, integer, text, boolean) from public, anon, authenticated;
revoke execute on function public.apply_plan_limits(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_plan_limits_safe(uuid, text) from public, anon, authenticated;
revoke execute on function public.preview_plan_limits(uuid) from public, anon, authenticated;
revoke execute on function public.advance_subscription_state(uuid) from public, anon, authenticated;
revoke execute on function public.sync_subscription_for(uuid, text) from public, anon, authenticated;
revoke execute on function public.run_plan_maintenance() from public, anon, authenticated;
revoke execute on function public.suspend_my_ads() from public, anon, authenticated;
revoke execute on function public.restore_my_suspended_ads() from public, anon, authenticated;
revoke execute on function public.enforce_product_catalog_rules() from public, anon, authenticated;

revoke execute on function public.subscribe_to_plan(text) from public, anon;
revoke execute on function public.sync_my_subscription() from public, anon;
revoke execute on function public.cancel_my_subscription() from public, anon;
revoke execute on function public.reactivate_my_subscription() from public, anon;
grant execute on function public.subscribe_to_plan(text) to authenticated;
grant execute on function public.sync_my_subscription() to authenticated;
grant execute on function public.cancel_my_subscription() to authenticated;
grant execute on function public.reactivate_my_subscription() to authenticated;

revoke execute on function public.company_public_products(uuid) from public, anon;
grant execute on function public.company_public_products(uuid) to authenticated;


-- --------------------------------------------------------------------------
-- 13) FOTOGRAFIA DEPOIS + COMPARAÇÃO -- nenhum dado pode ter mudado.
-- --------------------------------------------------------------------------
insert into _plc_foto
select
  'depois',
  (select count(*) from public.suppliers),
  (select count(*) from public.products),
  (select count(*) from public.product_images),
  (select count(*) from public.supplier_images),
  (select count(*) from public.subscriptions),
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s),
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p),
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i),
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g),
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b);

do $confere$
declare
  a _plc_foto;
  d _plc_foto;
begin
  select * into a from _plc_foto where momento = 'antes';
  select * into d from _plc_foto where momento = 'depois';
  if (a.suppliers, a.products, a.product_images, a.supplier_images, a.subscriptions,
      a.hash_suppliers, a.hash_products, a.hash_product_images, a.hash_supplier_images, a.hash_subscriptions)
     is distinct from
     (d.suppliers, d.products, d.product_images, d.supplier_images, d.subscriptions,
      d.hash_suppliers, d.hash_products, d.hash_product_images, d.hash_supplier_images, d.hash_subscriptions)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%', to_jsonb(a), to_jsonb(d);
  end if;
end
$confere$;

create temp table _plc_relatorio as select * from _plc_foto;

commit;

notify pgrst, 'reload schema';


-- ==========================================================================
-- 14) TESTES -- NADA FICA GRAVADO
--
-- Cada teste roda num sub-bloco que termina SEMPRE em exceção: o Postgres
-- desfaz escritas, eventos, notificações, `set role` e claims. Os cenários
-- montam o estado da conta P (a com mais anúncios ativos) como postgres e
-- chamam as funções reais -- inclusive subscribe_to_plan como o próprio
-- fornecedor.
-- ==========================================================================

create temp table _plc_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_p uuid;
  v_n_ads int;
  v_n_prod int;
  v_oldest uuid;
  v_res text;
  v_j jsonb;
begin
  select s.created_by into v_p
  from public.suppliers s
  where s.status = 'active' and public.fornecedor_current_plan_id(s.created_by) is not null
  group by s.created_by order by count(*) desc limit 1;

  if v_p is null then
    insert into _plc_testes values ('conta P', 'encontrada', 'nenhuma -- cenários pulados', false);
  else
    select count(*) into v_n_ads from public.suppliers where created_by = v_p and status in ('active', 'suspended');
    select count(*) into v_n_prod from public.products where created_by = v_p and status in ('active', 'suspended');
    select id into v_oldest from public.suppliers where created_by = v_p and status = 'active'
      order by created_at asc nulls last, id asc limit 1;
    insert into _plc_testes values ('conta P: anúncios / produtos candidatos', '-', v_n_ads || ' / ' || v_n_prod, null);

    -- G: todos os anúncios suspensos por no_plan, sem plano -> assina Básico
    --    COMO O FORNECEDOR. Antes desta etapa isto estourava PLAN_LIMIT.
    begin
      update public.subscriptions set status = 'expired', expires_at = now() - interval '1 second', next_charge_at = null
        where created_by = v_p and status in ('active', 'cancelled', 'scheduled');
      update public.suppliers set status = 'suspended', status_before_suspension = 'active',
             suspension_reason = 'no_plan', suspended_at = now() where created_by = v_p and status = 'active';
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      perform public.subscribe_to_plan('basico');
      perform set_config('role', 'postgres', true);
      select format('OK:ativos=%s plan_limit=%s no_plan=%s mais_antigo_ativo=%s',
               count(*) filter (where status = 'active'),
               count(*) filter (where suspension_reason = 'plan_limit'),
               count(*) filter (where suspension_reason = 'no_plan'),
               case when bool_or(id = v_oldest and status = 'active') then 'true' else 'false' end)
        into v_res from public.suppliers where created_by = v_p;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('G: suspensos no_plan -> assina Básico (como o fornecedor)',
      format('OK:ativos=1 plan_limit=%s no_plan=0 mais_antigo_ativo=true', v_n_ads - 1), v_res,
      v_res = format('OK:ativos=1 plan_limit=%s no_plan=0 mais_antigo_ativo=true', v_n_ads - 1));

    -- J: downgrade aplicado (plano vira Básico) com tudo ativo
    begin
      update public.subscriptions set plan_id = 'basico'
        where created_by = v_p and status in ('active', 'cancelled') and started_at <= now() and expires_at > now();
      v_j := public.apply_plan_limits(v_p, 'teste');
      select format('OK:ativos=%s plan_limit=%s produtos_ativos=%s produtos_plan_limit=%s',
               (select count(*) from public.suppliers where created_by = v_p and status = 'active'),
               (select count(*) from public.suppliers where created_by = v_p and suspension_reason = 'plan_limit'),
               (select count(*) from public.products where created_by = v_p and status = 'active'),
               (select count(*) from public.products where created_by = v_p and suspension_reason = 'plan_limit'))
        into v_res;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('J: vira Básico com tudo ativo',
      format('OK:ativos=1 plan_limit=%s produtos_ativos=%s produtos_plan_limit=%s', v_n_ads - 1, least(v_n_prod, 5), greatest(v_n_prod - 5, 0)),
      v_res,
      v_res = format('OK:ativos=1 plan_limit=%s produtos_ativos=%s produtos_plan_limit=%s', v_n_ads - 1, least(v_n_prod, 5), greatest(v_n_prod - 5, 0)));

    -- Idempotência: segunda aplicação nas mesmas condições não muda nada
    begin
      update public.subscriptions set plan_id = 'basico'
        where created_by = v_p and status in ('active', 'cancelled') and started_at <= now() and expires_at > now();
      perform public.apply_plan_limits(v_p, 'teste');
      v_j := public.apply_plan_limits(v_p, 'teste');
      v_res := format('OK:%s', (v_j->'ads'->>'restored')::int + (v_j->'ads'->>'suspended')::int + (v_j->'ads'->>'reason_changed')::int
                             + (v_j->'products'->>'restored')::int + (v_j->'products'->>'suspended')::int + (v_j->'products'->>'reason_changed')::int);
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('idempotência: 2ª aplicação muda', 'OK:0', v_res, v_res = 'OK:0');

    -- C/I: depois do Básico, volta a Premium -> todos restaurados
    begin
      update public.subscriptions set plan_id = 'basico'
        where created_by = v_p and status in ('active', 'cancelled') and started_at <= now() and expires_at > now();
      perform public.apply_plan_limits(v_p, 'teste');
      -- "Volta a Premium": antes subia a linha para premium no lugar; desde
      -- 2026-11-03 o gatilho trg_guard_paid_subscription (asaas-billing.sql)
      -- recusa isso. Aplica o limite do Premium direto -- é o que a central
      -- faria com o plano Premium vigente.
      perform public.fit_items_to_plan_limit('suppliers', v_p, public.plan_ad_limit('premium'), 'plan_limit');
      perform public.fit_items_to_plan_limit('products', v_p, public.plan_product_limit('premium'), 'plan_limit');
      select format('OK:suspensos=%s', count(*)) into v_res
        from public.suppliers where created_by = v_p and status = 'suspended';
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('C/I: Básico -> Premium restaura todos', 'OK:suspensos=0', v_res, v_res = 'OK:suspensos=0');

    -- E/F + conversão: perde o plano -> no_plan; pausado intocado;
    --                  plan_limit sem plano vira no_plan
    begin
      update public.subscriptions set plan_id = 'basico'
        where created_by = v_p and status in ('active', 'cancelled') and started_at <= now() and expires_at > now();
      perform public.apply_plan_limits(v_p, 'teste');                -- cria plan_limit
      update public.suppliers set status = 'paused' where id = (
        select id from public.suppliers where created_by = v_p and status = 'active' limit 1);
      update public.subscriptions set status = 'expired', expires_at = now() - interval '1 second'
        where created_by = v_p and status in ('active', 'cancelled', 'scheduled');
      perform public.apply_plan_limits(v_p, 'teste');
      select format('OK:ativos=%s pausados=%s plan_limit=%s no_plan=%s',
               count(*) filter (where status = 'active'),
               count(*) filter (where status = 'paused'),
               count(*) filter (where suspension_reason = 'plan_limit'),
               count(*) filter (where suspension_reason = 'no_plan'))
        into v_res from public.suppliers where created_by = v_p;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('E/F: perde o plano (1 pausado antes)',
      format('OK:ativos=0 pausados=1 plan_limit=0 no_plan=%s', v_n_ads - 1), v_res,
      v_res = format('OK:ativos=0 pausados=1 plan_limit=0 no_plan=%s', v_n_ads - 1));

    -- FALHA DA CENTRAL no meio da assinatura. A falha é simulada trocando
    -- plan_product_limit por uma versão que estoura -- DENTRO do sub-bloco, e
    -- DDL no Postgres é transacional: a troca é desfeita junto com o resto.
    -- Ela estoura no passo dos PRODUTOS, depois que os ANÚNCIOS já foram
    -- ajustados -- prova que a central volta inteira, não pela metade.
    -- Esperado: assinatura gravada, anúncios intactos (todos no_plan), evento
    -- plan_limits_failed com a mensagem.
    begin
      update public.subscriptions set status = 'expired', expires_at = now() - interval '1 second', next_charge_at = null
        where created_by = v_p and status in ('active', 'cancelled', 'scheduled');
      update public.suppliers set status = 'suspended', status_before_suspension = 'active',
             suspension_reason = 'no_plan', suspended_at = now() where created_by = v_p and status = 'active';
      execute $f$
        create or replace function public.plan_product_limit(plan_id text)
         returns integer language plpgsql immutable as $b$
        begin raise exception 'FALHA_SIMULADA'; end; $b$
      $f$;
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      perform public.subscribe_to_plan('basico');
      perform set_config('role', 'postgres', true);
      select format('OK:assinatura=%s ativos=%s evento=%s',
               (select plan_id from public.subscriptions where created_by = v_p and status = 'active' limit 1),
               (select count(*) from public.suppliers where created_by = v_p and status = 'active'),
               (select metadata->>'message' from public.subscription_events
                 where created_by = v_p and event_type = 'plan_limits_failed' order by created_at desc limit 1))
        into v_res;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('falha da central: assinatura fica, itens voltam, evento registra',
      'OK:assinatura=basico ativos=0 evento=FALHA_SIMULADA', v_res,
      v_res = 'OK:assinatura=basico ativos=0 evento=FALHA_SIMULADA');
    insert into _plc_testes
    select 'plan_product_limit intacto depois do teste', '5', public.plan_product_limit('basico')::text,
           public.plan_product_limit('basico') = 5;

    -- Cliente: ativar produto pausado no limite; ativar suspenso
    begin
      update public.subscriptions set plan_id = 'basico'
        where created_by = v_p and status in ('active', 'cancelled') and started_at <= now() and expires_at > now();
      perform public.apply_plan_limits(v_p, 'teste');
      update public.products set status = 'paused', suspension_reason = null, suspended_at = null
        where id = (select id from public.products where created_by = v_p and status = 'suspended' limit 1);
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.products set status = 'active'
        where id = (select id from public.products where created_by = v_p and status = 'paused' limit 1);
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('cliente ativa produto pausado com 5 ativos (Básico)', 'PLAN_LIMIT',
      left(v_res, 60), v_n_prod <= 5 or v_res like 'PLAN_LIMIT%');

    -- Visibilidade: anon não vê produto que não está ativo
    begin
      update public.products set status = 'paused' where id = (
        select id from public.products where created_by = v_p order by id limit 1);
      perform set_config('request.jwt.claims', '', true);
      perform set_config('role', 'anon', true);
      select format('OK:%s', count(*)) into v_res from public.products where status <> 'active';
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('anon lê produto não-ativo', 'OK:0', v_res, v_res = 'OK:0');

    begin
      update public.products set status = 'paused' where id = (
        select id from public.products where created_by = v_p order by id limit 1);
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      select format('OK:%s', count(*)) into v_res from public.products where created_by = v_p and status = 'paused';
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('dono lê o próprio produto pausado', 'OK:1', v_res, v_res = 'OK:1' or v_n_prod = 0);

    begin
      update public.products set status = 'paused' where id = (
        select id from public.products where created_by = v_p order by id limit 1);
      select format('OK:%s', count(*)) into v_res
      from public.company_public_products((select id from public.suppliers where created_by = v_p limit 1)) c
      join public.products p on p.id = c.id where p.status <> 'active';
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plc_testes values ('company_public_products devolve não-ativo', 'OK:0', v_res, v_res = 'OK:0');
  end if;

  -- Grants e legado
  insert into _plc_testes values
    ('authenticated executa suspend_my_ads', 'false',
      has_function_privilege('authenticated', 'public.suspend_my_ads()', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.suspend_my_ads()', 'EXECUTE')),
    ('authenticated executa restore_my_suspended_ads', 'false',
      has_function_privilege('authenticated', 'public.restore_my_suspended_ads()', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.restore_my_suspended_ads()', 'EXECUTE')),
    ('authenticated executa apply_plan_limits', 'false',
      has_function_privilege('authenticated', 'public.apply_plan_limits(uuid, text)', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.apply_plan_limits(uuid, text)', 'EXECUTE')),
    ('authenticated executa run_plan_maintenance', 'false',
      has_function_privilege('authenticated', 'public.run_plan_maintenance()', 'EXECUTE')::text,
      not has_function_privilege('authenticated', 'public.run_plan_maintenance()', 'EXECUTE')),
    ('authenticated executa subscribe_to_plan', 'true',
      has_function_privilege('authenticated', 'public.subscribe_to_plan(text)', 'EXECUTE')::text,
      has_function_privilege('authenticated', 'public.subscribe_to_plan(text)', 'EXECUTE'));

  insert into _plc_testes
  select 'legado: anúncio suspenso que estava pausado', '0', count(*)::text, count(*) = 0
  from public.suppliers where status = 'suspended' and status_before_suspension = 'paused';

  -- PRÉVIA: o que a central faria em cada conta HOJE (nada é gravado).
  insert into _plc_testes
  select '[prévia] conta ' || left(x.uid::text, 8),
         coalesce(pv->>'plan', 'SEM PLANO'),
         format('anúncios: ativos %s->%s, restaura %s, suspende %s, troca motivo %s | produtos: ativos %s->%s, restaura %s, suspende %s, troca motivo %s',
           pv->'ads'->>'active_before', pv->'ads'->>'active_after', pv->'ads'->>'restored',
           pv->'ads'->>'suspended', pv->'ads'->>'reason_changed',
           pv->'products'->>'active_before', pv->'products'->>'active_after', pv->'products'->>'restored',
           pv->'products'->>'suspended', pv->'products'->>'reason_changed'),
         null
  from (
    select created_by as uid from public.subscriptions
    union select created_by from public.suppliers
    union select created_by from public.products
  ) x
  cross join lateral (select public.preview_plan_limits(x.uid) as pv) p
  where x.uid is not null;
end
$testes$;


-- ==========================================================================
-- 15) RESULTADO
-- ==========================================================================
select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s',
              suppliers, products, product_images, supplier_images, subscriptions) as esperado,
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left(hash_suppliers, 8), left(hash_products, 8), left(hash_product_images, 8),
              left(hash_supplier_images, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _plc_relatorio
union all
select teste, esperado, obtido, ok from _plc_testes
union all
select 'contagem agora (pós-testes)',
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s',
              (select count(*) from public.suppliers), (select count(*) from public.products),
              (select count(*) from public.product_images), (select count(*) from public.supplier_images),
              (select count(*) from public.subscriptions)),
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left((select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s), 8),
              left((select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p), 8),
              left((select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i), 8),
              left((select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g), 8),
              left((select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b), 8)),
       null;
