-- *** 2026-11-03 (C1, Resumo.md §231-232): o subscribe_to_plan deste arquivo
-- ganhou a guarda PAYMENT_REQUIRED (só o Básico). A versão VIVA é a de
-- fix-paid-plan-activation.sql; se re-rodar este arquivo, rode depois
-- plan-limits-central.sql e fix-paid-plan-activation.sql (nessa ordem).
-- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
-- recusa assinatura paga sem pagamento aprovado mesmo assim. ***
-- NEXAR -- Correção do ciclo de assinatura: um plano ativo por conta e
-- troca de plano com agendamento.
--
-- Contexto (ver CONTEXTO.MD/Resumo.md seção 81): a versão anterior de
-- `subscribe_to_plan` era um INSERT puro -- não verificava nada, não
-- encerrava a assinatura anterior. Cada chamada criava MAIS UMA linha
-- 'active', então uma conta acumulava vários planos ativos ao mesmo tempo.
--
-- Regra de negócio decidida com o usuário:
--   - UPGRADE  (plano de posto maior): vale IMEDIATAMENTE. O cliente pagou
--     mais, recebe o benefício na hora; a assinatura anterior é encerrada.
--   - DOWNGRADE (posto menor, incluindo voltar pro Básico): AGENDADO. O
--     plano atual continua valendo até o vencimento e o novo entra sozinho
--     quando aquele terminar.
--   - Sair do Básico é sempre imediato -- o Básico é gratuito e tem
--     expires_at = 'infinity'; se a troca fosse agendada, ninguém sairia
--     dele nunca.
--
-- Arquivo autocontido, seguindo a convenção do projeto. PRECISA SER RODADO
-- MANUALMENTE no SQL Editor do Supabase. Re-executável do início ao fim.

-- ==========================================================================
-- 1) STATUS 'scheduled'
--
-- A assinatura agendada é uma linha normal em `subscriptions` com
-- status='scheduled' e started_at NO FUTURO (igual ao expires_at da
-- assinatura vigente). Nenhuma função de benefício enxerga esse status, então
-- ela não libera nada antes da hora.
-- ==========================================================================

-- Se existir um CHECK antigo restringindo os valores de status, ele barraria
-- 'scheduled'. Derrubado e recriado com o conjunto completo.
do $status_check$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.subscriptions drop constraint %I', c.conname);
  end loop;
end
$status_check$;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active', 'cancelled', 'expired', 'scheduled'));

-- ==========================================================================
-- 2) LIMPEZA DOS DUPLICADOS JÁ EXISTENTES
--
-- Antes de criar o índice único, as contas que já acumularam mais de uma
-- assinatura 'active' precisam ser reduzidas a uma. Critério: mantém a mais
-- recente (started_at desc) e encerra as demais.
-- ==========================================================================

with ranked as (
  select
    id,
    row_number() over (partition by created_by order by started_at desc, id) as rn
  from public.subscriptions
  where status = 'active'
)
update public.subscriptions s
set status = 'expired',
    expires_at = least(s.expires_at, now())
from ranked r
where s.id = r.id
  and r.rn > 1;

-- ==========================================================================
-- 3) INVARIANTE ESTRUTURAL -- no máximo 1 ativa e 1 agendada por conta
--
-- Índice parcial em cima de `status` (coluna, não expressão volátil): não dá
-- pra usar now() no predicado de um índice, então a garantia é sobre o
-- status. Quem move as vencidas para 'expired' é sync_my_subscription().
--
-- A partir daqui, "mais de um plano ativo" deixa de ser uma questão de
-- disciplina do código e passa a ser IMPOSSÍVEL no banco.
-- ==========================================================================

create unique index if not exists subscriptions_one_active_per_user
  on public.subscriptions (created_by)
  where status = 'active';

create unique index if not exists subscriptions_one_scheduled_per_user
  on public.subscriptions (created_by)
  where status = 'scheduled';

-- ==========================================================================
-- 4) HIERARQUIA DE PLANOS
-- ==========================================================================

create or replace function public.plan_rank(p_plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select case p_plan_id
    when 'basico' then 0
    when 'profissional' then 1
    when 'premium' then 2
    else -1
  end;
$function$;

-- ==========================================================================
-- 5) `fornecedor_current_plan_id` -- CORREÇÃO DE BUG
--
-- A versão em rls-policies.sql filtra só por `expires_at > now()`, sem olhar
-- status, e ordena por started_at desc. Uma linha 'scheduled' (started_at e
-- expires_at no futuro) GANHARIA essa ordenação e passaria a valer como
-- "plano atual" -- liberando os limites do plano novo antes da data. Também
-- é o que fazia a função escolher arbitrariamente entre várias ativas.
--
-- Agora exige status de benefício real e que a vigência já tenha começado.
-- ==========================================================================

create or replace function public.fornecedor_current_plan_id(p_uid uuid)
 returns text
 language sql
 stable
as $function$
  select s.plan_id
  from public.subscriptions s
  where s.created_by = p_uid
    and s.status in ('active', 'cancelled')
    and s.started_at <= now()
    and s.expires_at > now()
  order by s.started_at desc
  limit 1;
$function$;

-- ==========================================================================
-- 6) `subscribe_to_plan` -- REESCRITA
-- ==========================================================================

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
  v_starts timestamptz;
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

  -- Assinatura que está DANDO BENEFÍCIO agora. 'cancelled' entra porque o
  -- plano cancelado continua valendo até o vencimento (ver
  -- cancel_my_subscription em rls-policies.sql).
  select * into v_current
  from public.subscriptions
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and started_at <= now()
    and expires_at > now()
  order by started_at desc
  limit 1;

  -- ---------- Sem plano vigente: entra na hora ----------
  if v_current.id is null then
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

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
  end if;

  if v_current.plan_id = p_plan_id then
    raise exception 'ALREADY_ON_PLAN';
  end if;

  -- ---------- UPGRADE: vale agora ----------
  if public.plan_rank(p_plan_id) > public.plan_rank(v_current.plan_id) then
    -- Um agendamento pendente perde o sentido depois de um upgrade.
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

    update public.subscriptions
    set status = 'expired', expires_at = now()
    where id = v_current.id;

    insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
    values (v_uid, p_plan_id, 'active', now(), now() + interval '30 days')
    returning * into v_row;

    return v_row;
  end if;

  -- ---------- DOWNGRADE: agendado para o fim do ciclo atual ----------
  -- Guarda-costas: o Básico é 'infinity' e nunca venceria, então um
  -- agendamento a partir dele ficaria preso para sempre. Não deveria chegar
  -- aqui (Básico é rank 0, não há downgrade a partir dele), mas se o mapa de
  -- postos mudar um dia, falha explícito em vez de travar o fornecedor.
  if v_current.expires_at = 'infinity'::timestamptz then
    raise exception 'CANNOT_SCHEDULE_FROM_UNLIMITED_PLAN';
  end if;

  v_starts := v_current.expires_at;

  -- Só pode haver um agendamento: o novo substitui o anterior.
  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
  values (
    v_uid,
    p_plan_id,
    'scheduled',
    v_starts,
    case when p_plan_id = 'basico' then 'infinity'::timestamptz else v_starts + interval '30 days' end
  )
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.subscribe_to_plan(text) from public;
grant execute on function public.subscribe_to_plan(text) to authenticated;

-- ==========================================================================
-- 7) Desfazer um agendamento (o fornecedor mudou de ideia)
-- ==========================================================================

create or replace function public.cancel_scheduled_plan_change()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';
end;
$function$;

revoke execute on function public.cancel_scheduled_plan_change() from public;
grant execute on function public.cancel_scheduled_plan_change() to authenticated;

-- ==========================================================================
-- 8) `sync_my_subscription` -- REESCRITA
--
-- Além de expirar as vencidas, agora PROMOVE a assinatura agendada quando
-- chega a data dela.
--
-- Correção de comportamento junto: a versão anterior pausava os anúncios
-- sempre que alguma assinatura expirava. Com agendamento isso ficaria
-- errado -- numa troca Premium->Profissional o plano antigo expira e o novo
-- assume no mesmo instante, e os anúncios seriam pausados sem motivo. Agora
-- a pausa depende de o fornecedor ter REALMENTE ficado sem plano vigente.
-- ==========================================================================

create or replace function public.sync_my_subscription()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_has_benefits boolean;
begin
  if v_uid is null then
    return;
  end if;

  -- (a) encerra o que venceu -- libera o slot do índice único de 'active'
  update public.subscriptions
  set status = 'expired'
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and expires_at <= now();

  -- (b) promove o agendamento cuja data chegou
  update public.subscriptions
  set status = 'active'
  where created_by = v_uid
    and status = 'scheduled'
    and started_at <= now();

  -- (c) se o promovido já nasceu vencido (fornecedor sumiu por muito tempo),
  --     encerra também
  update public.subscriptions
  set status = 'expired'
  where created_by = v_uid
    and status = 'active'
    and expires_at <= now();

  -- (d) pausa os anúncios só se sobrou mesmo sem plano
  select exists (
    select 1 from public.subscriptions
    where created_by = v_uid
      and status in ('active', 'cancelled')
      and started_at <= now()
      and expires_at > now()
  ) into v_has_benefits;

  if not v_has_benefits then
    update public.suppliers
    set status = 'paused'
    where created_by = v_uid and status = 'active';
  end if;
end;
$function$;

revoke execute on function public.sync_my_subscription() from public;
grant execute on function public.sync_my_subscription() to authenticated;

-- ==========================================================================
-- 9) Leitura da assinatura vigente e da agendada
--
-- O client lia `subscriptions` direto com order by started_at desc limit 1 --
-- o que passaria a devolver a linha AGENDADA (started_at futuro) como se
-- fosse a atual. Estas duas RPCs deixam a intenção explícita e blindam o
-- client contra esse erro de ordenação.
-- ==========================================================================

create or replace function public.my_current_subscription()
 returns subscriptions
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select *
  from public.subscriptions
  where created_by = auth.uid()
    and status <> 'scheduled'
  order by started_at desc
  limit 1;
$function$;

create or replace function public.my_scheduled_subscription()
 returns subscriptions
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select *
  from public.subscriptions
  where created_by = auth.uid()
    and status = 'scheduled'
  limit 1;
$function$;

revoke execute on function public.my_current_subscription() from public;
revoke execute on function public.my_scheduled_subscription() from public;
grant execute on function public.my_current_subscription() to authenticated;
grant execute on function public.my_scheduled_subscription() to authenticated;
