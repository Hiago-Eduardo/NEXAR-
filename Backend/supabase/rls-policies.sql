-- *** 2026-11-03 (C1, Resumo.md §231-232): o subscribe_to_plan deste arquivo
-- ganhou a guarda PAYMENT_REQUIRED (só o Básico). A versão VIVA é a de
-- fix-paid-plan-activation.sql; se re-rodar este arquivo, rode depois
-- plan-limits-central.sql e fix-paid-plan-activation.sql (nessa ordem).
-- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
-- recusa assinatura paga sem pagamento aprovado mesmo assim. ***
-- NEXAR -- Row Level Security + RPCs "core" (tabelas principais, ciclo de
-- vida de assinatura/plano, métricas de anúncio/lead).
--
-- Reconstruído em 2026-09-17 a partir do que está DE FATO rodando no
-- Supabase (dump via pg_proc/pg_policies/information_schema, feito com o
-- usuário direto no SQL Editor). A versão anterior deste arquivo continha
-- só texto de um prompt/bug-report antigo salvo por engano com extensão
-- .sql -- não era SQL executável e não refletia o banco real. Ver
-- CONTEXTO.MD/Resumo.md seções 42-45 pra esse histórico.
--
-- Este arquivo é só para consulta/histórico -- já está tudo aplicado no
-- Supabase. Se precisar recriar do zero, roda de cima para baixo.

-- ==========================================================================
-- 1) ROW LEVEL SECURITY -- habilitada em todas as tabelas do app
-- ==========================================================================

alter table public.suppliers enable row level security;
alter table public.products enable row level security;
alter table public.reviews enable row level security;
alter table public.user_profiles enable row level security;
alter table public.contact_requests enable row level security;
alter table public.chat_messages enable row level security;
alter table public.subscriptions enable row level security;
alter table public.ad_views enable row level security;

-- ==========================================================================
-- 2) POLICIES -- suppliers
-- ==========================================================================

create policy "Public can read active suppliers, owners read all their own"
on public.suppliers
for select
to anon, authenticated
using (
  coalesce(status, 'active') = 'active'
  or auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Fornecedores podem criar seus proprios anuncios"
on public.suppliers
for insert
to authenticated
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can update suppliers"
on public.suppliers
for update
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can delete suppliers"
on public.suppliers
for delete
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 3) POLICIES -- products (produtos do catálogo de um anúncio)
-- ==========================================================================

create policy "Public can read products"
on public.products
for select
to anon, authenticated
using (true);

create policy "Users can create own products"
on public.products
for insert
to authenticated
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can update products"
on public.products
for update
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can delete products"
on public.products
for delete
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 4) POLICIES -- reviews (mesmo formato de products)
-- ==========================================================================

create policy "Public can read reviews"
on public.reviews
for select
to anon, authenticated
using (true);

create policy "Users can create own reviews"
on public.reviews
for insert
to authenticated
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can update reviews"
on public.reviews
for update
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Owners can delete reviews"
on public.reviews
for delete
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 5) POLICIES -- user_profiles
--
-- Só o dono (created_by = auth.uid()) ou admin lê/escreve a própria linha --
-- de propósito, não existe policy de select público. Qualquer tela que
-- precise mostrar dados de user_profiles publicamente tem que passar por
-- uma RPC security definer (company_public_profile, company_search_public)
-- que devolve só as colunas "seguras" -- nunca acessar a tabela direto pra
-- isso. Ver CLAUDE.md > "Security-definer RPC pattern".
-- ==========================================================================

create policy "Users can read own profile"
on public.user_profiles
for select
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can create own profile"
on public.user_profiles
for insert
to authenticated
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can update own profile"
on public.user_profiles
for update
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can delete own profile"
on public.user_profiles
for delete
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 6) POLICIES -- contact_requests (formulário "solicitar orçamento")
-- ==========================================================================

create policy "Authenticated users can create contact requests"
on public.contact_requests
for insert
to authenticated
with check (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can read contact requests"
on public.contact_requests
for select
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_email) = lower(auth.jwt() ->> 'email')
  or exists (
    select 1 from public.suppliers s
    where s.id = contact_requests.supplier_id and s.created_by = auth.uid()
  )
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can update contact requests"
on public.contact_requests
for update
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_email) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or lower(sender_email) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can delete contact requests"
on public.contact_requests
for delete
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_email) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 7) POLICIES -- chat_messages
-- ==========================================================================

create policy "Participants can read chat messages"
on public.chat_messages
for select
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_id) = lower(auth.jwt() ->> 'email')
  or lower(receiver_id) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Users can create own chat messages"
on public.chat_messages
for insert
to authenticated
with check (
  auth.uid() = created_by
  and lower(sender_id) = lower(auth.jwt() ->> 'email')
);

create policy "Senders can update chat messages"
on public.chat_messages
for update
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_id) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
)
with check (
  auth.uid() = created_by
  or lower(sender_id) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

create policy "Senders can delete chat messages"
on public.chat_messages
for delete
to authenticated
using (
  auth.uid() = created_by
  or lower(sender_id) = lower(auth.jwt() ->> 'email')
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 8) POLICIES -- subscriptions
--
-- Só existe policy de SELECT (dono ou admin). Não existe policy de
-- insert/update/delete de propósito -- a única forma de criar/alterar uma
-- assinatura é pelas RPCs security definer da seção 10 (subscribe_to_plan,
-- cancel_my_subscription, reactivate_my_subscription, sync_my_subscription),
-- que rodam com privilégio elevado e por isso ignoram RLS. Isso impede o
-- client de escrever started_at/expires_at/status diretamente.
-- ==========================================================================

create policy "Owners can read own subscriptions"
on public.subscriptions
for select
to authenticated
using (
  auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 9) ad_views
--
-- RLS habilitada e SEM NENHUMA policy -- ninguém (nem authenticated) lê ou
-- escreve essa tabela direto. Todo acesso é através das RPCs security
-- definer da seção 11 (register_ad_view para escrever,
-- my_ad_view_counts/my_daily_stats para ler agregado). Isso é intencional:
-- impede qualquer usuário de inflar/ver visualizações de anúncio de outra
-- empresa diretamente pela tabela.
-- ==========================================================================

-- ==========================================================================
-- 10) Helpers de plano + trigger de regras do anúncio
-- ==========================================================================

create or replace function public.plan_ad_limit(plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select case plan_id
    when 'basico' then 1
    when 'profissional' then 5
    when 'premium' then 2147483647
    else 0
  end;
$function$;

create or replace function public.fornecedor_has_active_plan(p_uid uuid)
 returns boolean
 language sql
 stable
as $function$
  select exists (
    select 1 from public.subscriptions s
    where s.created_by = p_uid
      and s.expires_at > now()
  );
$function$;

create or replace function public.fornecedor_active_ad_count(p_uid uuid)
 returns integer
 language sql
 stable
as $function$
  select count(*)::int from public.suppliers s
  where s.created_by = p_uid and s.status = 'active';
$function$;

create or replace function public.fornecedor_current_plan_id(p_uid uuid)
 returns text
 language sql
 stable
as $function$
  select s.plan_id from public.subscriptions s
  where s.created_by = p_uid
    and s.expires_at > now()
  order by s.started_at desc
  limit 1;
$function$;

-- Bloqueia (RAISE EXCEPTION) publicar/reativar um anúncio sem plano ativo ou
-- acima do limite de anúncios do plano -- ver PLAN_AD_LIMITS em
-- src/lib/plans.js, que precisa ficar em sincronia com plan_ad_limit() acima.
create or replace function public.enforce_supplier_ad_rules()
 returns trigger
 language plpgsql
as $function$
declare
  is_admin boolean := (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
  activating boolean;
begin
  if is_admin then
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

create trigger trg_enforce_supplier_ad_rules
before insert or update on public.suppliers
for each row execute function public.enforce_supplier_ad_rules();

-- plan_ad_limit/fornecedor_*/enforce_supplier_ad_rules ficaram com o grant
-- padrão do Postgres (EXECUTE para PUBLIC) -- não foram revogados, e não
-- precisam ser: não expõem nada que already não esteja acessível pelas
-- policies acima, e enforce_supplier_ad_rules() é função de trigger (não é
-- chamável via RPC/PostgREST).

-- ==========================================================================
-- 11) Ciclo de vida da assinatura (RPCs chamadas por api.subscriptions.*)
--
-- Todas exigem auth.uid() (RAISE EXCEPTION 'AUTH_REQUIRED' se anônimo) --
-- por isso o EXECUTE é só pra "authenticated", nunca "anon".
-- ==========================================================================

create or replace function public.subscribe_to_plan(p_plan_id text)
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

  insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
  values (
    v_uid,
    p_plan_id,
    'active',
    now(),
    case when p_plan_id = 'basico' then 'infinity'::timestamptz else now() + interval '30 days' end
  )
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.subscribe_to_plan(text) from public;
grant execute on function public.subscribe_to_plan(text) to authenticated;

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

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'active' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_ACTIVE_SUBSCRIPTION';
  end if;

  if v_row.plan_id = 'basico' then
    -- Plano gratuito: nao ha carencia paga a preservar, cancelamento e imediato.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), expires_at = now()
    where id = v_row.id
    returning * into v_row;
  else
    -- Plano pago: mantem expires_at original -- fornecedor continua com os beneficios
    -- ate o vencimento, so nao havera renovacao automatica.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now()
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.cancel_my_subscription() from public;
grant execute on function public.cancel_my_subscription() to authenticated;

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

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'cancelled' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_CANCELLED_SUBSCRIPTION';
  end if;

  update public.subscriptions
  set status = 'active', cancelled_at = null
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.reactivate_my_subscription() from public;
grant execute on function public.reactivate_my_subscription() to authenticated;

-- Idempotente: marca assinaturas vencidas como expiradas e pausa os
-- anuncios que estavam ativos. Chamado ao carregar telas de plano/anuncios
-- (api.subscriptions.sync).
create or replace function public.sync_my_subscription()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_expired_count integer;
begin
  if v_uid is null then
    return;
  end if;

  update public.subscriptions
  set status = 'expired'
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and expires_at <= now();
  get diagnostics v_expired_count = row_count;

  if v_expired_count > 0 then
    update public.suppliers
    set status = 'paused'
    where created_by = v_uid and status = 'active';
  end if;
end;
$function$;

revoke execute on function public.sync_my_subscription() from public;
grant execute on function public.sync_my_subscription() to authenticated;

-- ==========================================================================
-- 12) Selo "Verificado" público (api.verification.getForSuppliers)
-- ==========================================================================

create or replace function public.suppliers_verified_status(p_supplier_ids uuid[])
 returns table(supplier_id uuid, is_verified boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    s.id as supplier_id,
    exists (
      select 1
      from public.subscriptions sub
      where sub.created_by = s.created_by
        and sub.plan_id = 'premium'
        and sub.status in ('active', 'cancelled')
        and sub.expires_at > now()
    ) as is_verified
  from public.suppliers s
  where s.id = any(p_supplier_ids);
$function$;

revoke execute on function public.suppliers_verified_status(uuid[]) from public;
grant execute on function public.suppliers_verified_status(uuid[]) to anon, authenticated;

-- ==========================================================================
-- 13) Métricas de ad view / lead (api.metrics.*)
--
-- register_ad_view precisa aceitar anon (visitante sem login, identificado
-- só por p_session_id) -- as demais são sempre do dono logado, só
-- "authenticated". supplier_leads é referenciada por my_lead_counts e
-- my_daily_stats mas não apareceu no dump de "select relname from pg_class
-- where relkind='r'" desta sessão -- pode ser uma view (não uma tabela
-- base) derivada de contact_requests; vale confirmar numa sessão futura se
-- for tocar nessas duas funções.
-- ==========================================================================

create or replace function public.register_ad_view(p_supplier_id uuid, p_session_id text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
begin
  select created_by into v_owner from public.suppliers where id = p_supplier_id;
  if v_owner is null then
    return;
  end if;

  if v_uid is not null and v_uid = v_owner then
    return;
  end if;

  if v_uid is not null then
    insert into public.ad_views (supplier_id, viewer_user_id, viewed_on)
    values (p_supplier_id, v_uid, current_date)
    on conflict do nothing;
  elsif p_session_id is not null and length(p_session_id) between 8 and 100 then
    insert into public.ad_views (supplier_id, viewer_session_id, viewed_on)
    values (p_supplier_id, p_session_id, current_date)
    on conflict do nothing;
  end if;
end;
$function$;

revoke execute on function public.register_ad_view(uuid, text) from public;
grant execute on function public.register_ad_view(uuid, text) to anon, authenticated;

create or replace function public.my_ad_view_counts()
 returns table(supplier_id uuid, views bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select v.supplier_id, count(*)::bigint
  from public.ad_views v
  join public.suppliers s on s.id = v.supplier_id
  where s.created_by = auth.uid()
  group by v.supplier_id;
$function$;

revoke execute on function public.my_ad_view_counts() from public;
grant execute on function public.my_ad_view_counts() to authenticated;

create or replace function public.my_lead_counts()
 returns table(supplier_id uuid, leads bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select l.supplier_id, count(*)::bigint
  from public.supplier_leads l
  join public.suppliers s on s.id = l.supplier_id
  where s.created_by = auth.uid()
  group by l.supplier_id;
$function$;

revoke execute on function public.my_lead_counts() from public;
grant execute on function public.my_lead_counts() to authenticated;

create or replace function public.my_daily_stats(p_days integer default 30)
 returns table(day date, views bigint, contacts bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  with days as (
    select generate_series(current_date - (greatest(p_days, 1) - 1), current_date, interval '1 day')::date as day
  ),
  my_supplier_ids as (
    select id from public.suppliers where created_by = auth.uid()
  ),
  daily_views as (
    select viewed_on as day, count(*)::bigint as views
    from public.ad_views
    where supplier_id in (select id from my_supplier_ids)
    group by viewed_on
  ),
  daily_leads as (
    select first_contact_at::date as day, count(*)::bigint as contacts
    from public.supplier_leads
    where supplier_id in (select id from my_supplier_ids)
    group by first_contact_at::date
  )
  select d.day, coalesce(dv.views, 0), coalesce(dl.contacts, 0)
  from days d
  left join daily_views dv on dv.day = d.day
  left join daily_leads dl on dl.day = d.day
  order by d.day;
$function$;

revoke execute on function public.my_daily_stats(integer) from public;
grant execute on function public.my_daily_stats(integer) to authenticated;
