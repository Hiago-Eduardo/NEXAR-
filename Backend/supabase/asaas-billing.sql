-- ==========================================================================
-- COBRANÇA VIA ASAAS -- BASE (Resumo.md seção 232). PREPARADO, NÃO RODADO.
--
-- Roda DEPOIS de fix-paid-plan-activation.sql (recusa rodar sem a guarda
-- C1). Um ÚNICO bloco DO: o SQL Editor não mantém "begin; ...; commit;"
-- numa transação (seção 231). Falhou qualquer coisa -> nada fica.
--
-- O QUE ENTRA
--   1. billing_config (uma linha, só o banco/postgres mexe):
--      accepted_environment = NULL | 'sandbox' | 'production'.
--      NULL (o padrão, e o valor que este arquivo deixa) = NENHUM pagamento
--      ativa plano e nenhuma cobrança é criada. O NEXAR usa UM projeto
--      Supabase para dev e produção: um pagamento do Sandbox jamais pode
--      ativar plano aqui. Para homologar, use um projeto Supabase de TESTE e
--      lá rode: update public.billing_config set accepted_environment = 'sandbox';
--   2. billing_customers: cliente do Asaas por (conta, ambiente). O Asaas
--      aceita cliente duplicado -- a chave aqui impede.
--   3. payments ganha environment, covers_until, gateway_customer_id,
--      gateway_status (status cru do Asaas), invoice_url, consumed_at,
--      unapplied_reason. Índice: UMA cobrança em aberto por conta/ambiente.
--   4. subscriptions ganha payment_id (único: cada pagamento é consumido UMA
--      vez) e o GATILHO trg_guard_paid_subscription -- a proteção que não
--      depende de nenhum corpo de função:
--        * INSERT de plano pago só com payment_id de um pagamento 'approved'
--          da MESMA conta e MESMO plano, no ambiente aceito, com expires_at
--          <= covers_until e status 'active';
--        * UPDATE de linha paga: não troca plan_id para pago, não mexe em
--          payment_id/started_at, não aumenta expires_at, não sai de
--          'expired'. Encurtar, cancelar, reativar dentro do período e
--          vencer continuam (as 2 contas Profissional de 10/11 incluídas).
--      Assim, re-rodar QUALQUER arquivo antigo (subscribe_to_plan que
--      grava plano pago) não reabre a C1: o insert é recusado.
--   5. Funções SÓ service_role (Edge Functions): billing_prepare_checkout,
--      billing_attach_gateway_charge, billing_customer_get/save,
--      billing_webhook_begin/finish, billing_apply_gateway_payment.
--      Preço, plano, conta e período saem do BANCO (billing_quote), nunca
--      do navegador.
--
-- REGRA DE COBRANÇA PROVISÓRIA (decisão pendente -- ver Resumo §232):
--   billing_quote = preço mensal de plans.js (R$ 49 / R$ 99) cobrindo até o
--   próximo dia 10 (next_billing_date). Proporcionalidade, renovação,
--   upgrade entre pagos, atraso e estorno NÃO estão decididos; o motor
--   confia só no que billing_quote devolve, então mudar a regra é mudar
--   essa função. O checkout fica DESLIGADO até a decisão.
--
-- §233 (2026-11-04) -- pendentes vencidas, concorrência e recuperação:
--   * billing_prepare_checkout devolve uma AÇÃO: reuse (fatura válida),
--     create (com reserva gateway_claim_until -- só quem tem a reserva cria
--     no Asaas), wait (outra requisição criando agora) ou check_stale
--     (pendente vencida: due_date passou ou o ciclo virou). O banco nunca
--     cancela sozinho: a Edge Function re-consulta no Asaas, remove se em
--     aberto, CONFERE de novo e só então anula (a linha fica: refused +
--     closed_reason). Paga no meio do caminho -> aplica e não cria outra.
--   * payments.due_date / gateway_claim_until / closed_reason;
--     billing_void_unattached (pendente que nunca chegou ao Asaas);
--     billing_reviews + billing_review_add (análise manual: divergência,
--     órfã, paga sem aplicar, paga depois de anulada, erro permanente);
--     billing_reconcile_candidates (eventos parados e pendentes sem notícia,
--     para a Edge Function billing-reconcile).
--   * Outro plano com fatura ainda no prazo: continua PENDING_CHARGE_EXISTS
--     (decisão comercial pendente).
--
-- NÃO ENTRA: renovação automática (não há assinatura recorrente no Asaas;
-- a manutenção local continua só VENCENDO -- nada renova duas vezes),
-- upgrade Profissional -> Premium pago, reembolso parcial.
--
-- RE-EXECUTÁVEL. Rodar MANUALMENTE no SQL Editor, num projeto de TESTE
-- primeiro. Não altera nenhuma linha existente (fotografia antes/depois).
-- ==========================================================================

do $mig$
declare
  v_tab text;
  v_list text;
begin
  perform set_config('lock_timeout', '15s', true);

  -- ------------------------------------------------------------------------
  -- 0) PRÉ-REQUISITOS
  -- ------------------------------------------------------------------------
  if to_regclass('public.payments') is null or to_regclass('public.webhook_events') is null
     or to_regclass('public.subscription_events') is null then
    raise exception 'PRECHECK: rode payments-audit-notifications.sql antes. Nada foi alterado.';
  end if;
  if to_regprocedure('public.subscribe_to_plan(text)') is null
     or position('PAYMENT_REQUIRED' in (select prosrc from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure)) = 0 then
    raise exception 'PRECHECK: a guarda C1 não está no corpo vivo de subscribe_to_plan -- rode fix-paid-plan-activation.sql antes. Nada foi alterado.';
  end if;
  select string_agg(f, ', ') into v_list
  from unnest(array['public.lock_plan_account(uuid)', 'public.advance_subscription_state(uuid)',
                    'public.apply_plan_limits_safe(uuid,text)', 'public.next_billing_date(timestamptz)',
                    'public.fornecedor_current_plan_id(uuid)']) f
  where to_regprocedure(f) is null;
  if v_list is not null then
    raise exception 'PRECHECK: funções ausentes: %. Nada foi alterado.', v_list;
  end if;

  -- Ninguém de fora grava nas tabelas fotografadas enquanto isto roda.
  foreach v_tab in array array['subscriptions', 'payments', 'webhook_events', 'subscription_events',
                               'notifications', 'email_outbox', 'suppliers', 'products'] loop
    if to_regclass('public.' || v_tab) is not null then
      execute format('lock table public.%I in share mode', v_tab);
    end if;
  end loop;

  -- Fotografia ANTES. As colunas novas saem do hash (nas linhas antigas elas
  -- nascem NULL) -- o resto da linha tem de ficar idêntico.
  create temp table _bl_foto (momento text, tabela text, linhas bigint, hash text) on commit drop;
  create temp table _bl_testes (teste text, esperado text, obtido text, ok boolean) on commit drop;

  create or replace function pg_temp.bl_fotografar(p_momento text)
   returns void
   language plpgsql
  as $f$
  declare
    t text;
    v_n bigint;
    v_h text;
  begin
    foreach t in array array['subscriptions', 'payments', 'payment_attempts', 'payment_methods', 'webhook_events',
                             'subscription_events', 'notifications', 'email_outbox', 'suppliers', 'products'] loop
      if to_regclass('public.' || t) is not null then
        execute format(
          'select count(*), md5(coalesce(string_agg((to_jsonb(x) - %L::text[])::text, ''|'' order by (to_jsonb(x) - %L::text[])::text), '''')) from public.%I x',
          array['payment_id', 'environment', 'covers_until', 'gateway_customer_id', 'gateway_status',
                'invoice_url', 'consumed_at', 'unapplied_reason', 'due_date', 'gateway_claim_until', 'closed_reason'],
          array['payment_id', 'environment', 'covers_until', 'gateway_customer_id', 'gateway_status',
                'invoice_url', 'consumed_at', 'unapplied_reason', 'due_date', 'gateway_claim_until', 'closed_reason'], t)
          into v_n, v_h;
        insert into _bl_foto values (p_momento, t, v_n, v_h);
      end if;
    end loop;
  end;
  $f$;

  perform pg_temp.bl_fotografar('antes');


  -- ------------------------------------------------------------------------
  -- 1) CONFIGURAÇÃO DO AMBIENTE ACEITO -- NULL = cobrança desligada
  -- ------------------------------------------------------------------------
  create table if not exists public.billing_config (
    id boolean primary key default true check (id),
    accepted_environment text check (accepted_environment in ('sandbox', 'production')),
    updated_at timestamptz not null default now()
  );
  insert into public.billing_config (id) values (true) on conflict (id) do nothing;
  alter table public.billing_config enable row level security;
  revoke all on public.billing_config from public, anon, authenticated;

  create or replace function public.billing_accepted_environment()
   returns text
   language sql
   stable security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    select accepted_environment from public.billing_config where id;
  $f$;


  -- ------------------------------------------------------------------------
  -- 2) CLIENTE DO ASAAS POR CONTA E AMBIENTE
  -- ------------------------------------------------------------------------
  create table if not exists public.billing_customers (
    user_id uuid not null references auth.users(id) on delete cascade,
    environment text not null check (environment in ('sandbox', 'production')),
    gateway text not null default 'asaas',
    gateway_customer_id text not null,
    created_at timestamptz not null default now(),
    primary key (user_id, environment, gateway),
    unique (gateway, environment, gateway_customer_id)
  );
  alter table public.billing_customers enable row level security;
  revoke all on public.billing_customers from public, anon, authenticated;


  -- ------------------------------------------------------------------------
  -- 3) PAYMENTS -- colunas do gateway (estrutura existente reaproveitada)
  -- ------------------------------------------------------------------------
  alter table public.payments add column if not exists environment text
    check (environment in ('sandbox', 'production'));
  alter table public.payments add column if not exists covers_until timestamptz;
  alter table public.payments add column if not exists gateway_customer_id text;
  -- Status CRU do Asaas (PENDING, CONFIRMED, RECEIVED, OVERDUE, REFUNDED,
  -- CHARGEBACK_*...). `status` continua com o CHECK de 4 valores.
  alter table public.payments add column if not exists gateway_status text;
  alter table public.payments add column if not exists invoice_url text;
  -- Quando o pagamento virou benefício (uma vez só).
  alter table public.payments add column if not exists consumed_at timestamptz;
  -- Aprovado mas NÃO aplicado (atraso, já tinha plano pago...) -- caso manual.
  alter table public.payments add column if not exists unapplied_reason text;

  -- Vencimento da fatura (de billing_quote): é o que define "pendente
  -- vencida" -- antes só a Edge Function sabia (§233).
  alter table public.payments add column if not exists due_date date;
  -- Reserva da criação no Asaas: enquanto vale, ninguém mais cria a
  -- cobrança desta linha (dois checkouts ao mesmo tempo não geram duas
  -- faturas com a mesma referência). Some quando a cobrança é ligada.
  alter table public.payments add column if not exists gateway_claim_until timestamptz;
  -- Por que uma pendente foi encerrada sem pagamento (auditoria):
  -- deleted_at_gateway | unattached_void.
  alter table public.payments add column if not exists closed_reason text;

  -- Uma cobrança em aberto por conta e ambiente: impede gerar várias
  -- faturas com cliques repetidos. payments_one_per_cycle não cobre
  -- subscription_id NULL, que é como a cobrança nasce.
  create unique index if not exists payments_one_open_charge
    on public.payments (created_by, environment) where status = 'pending';


  -- Fila de ANÁLISE MANUAL (§233): pagamento recusado por divergência,
  -- cobrança desconhecida, pago sem poder aplicar, pago depois de anulado,
  -- erro permanente ao re-consultar. Uma linha aberta por motivo+alvo.
  -- Só o banco/backend lê e grava.
  create table if not exists public.billing_reviews (
    id uuid primary key default gen_random_uuid(),
    created_at timestamptz not null default now(),
    created_by uuid,
    payment_id uuid references public.payments(id),
    gateway_payment_id text,
    event_id text,
    reason text not null,
    details jsonb,
    resolved_at timestamptz,
    resolution text
  );
  create unique index if not exists billing_reviews_open_once
    on public.billing_reviews (reason, coalesce(payment_id::text, gateway_payment_id, event_id, ''))
    where resolved_at is null;
  alter table public.billing_reviews enable row level security;
  revoke all on public.billing_reviews from public, anon, authenticated;


  -- ------------------------------------------------------------------------
  -- 4) SUBSCRIPTIONS -- pagamento consumido uma vez + o GATILHO
  -- ------------------------------------------------------------------------
  alter table public.subscriptions add column if not exists payment_id uuid references public.payments(id);
  create unique index if not exists subscriptions_payment_once
    on public.subscriptions (payment_id) where payment_id is not null;

  create or replace function public.guard_paid_subscription()
   returns trigger
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    p public.payments;
  begin
    if tg_op = 'INSERT' then
      if new.plan_id = 'basico' then
        if new.payment_id is not null then
          raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: Básico não consome pagamento';
        end if;
        return new;
      end if;

      if new.payment_id is null then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: plano pago sem pagamento aprovado';
      end if;
      select * into p from public.payments where id = new.payment_id;
      if p.id is null
         or p.status <> 'approved'
         or p.created_by is distinct from new.created_by
         or p.plan_id is distinct from new.plan_id
         or p.covers_until is null
         or new.expires_at > p.covers_until
         or new.status <> 'active'
         or p.environment is null
         or p.environment is distinct from public.billing_accepted_environment() then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: pagamento não corresponde à assinatura';
      end if;
      return new;
    end if;

    -- UPDATE
    if new.payment_id is distinct from old.payment_id then
      raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: payment_id não muda';
    end if;
    if new.plan_id is distinct from old.plan_id and new.plan_id <> 'basico' then
      raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: troca para plano pago só com pagamento';
    end if;
    if new.plan_id <> 'basico' then
      if new.created_by is distinct from old.created_by then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: assinatura paga não muda de conta';
      end if;
      if new.expires_at > old.expires_at then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: período pago não se estende sem pagamento';
      end if;
      if new.started_at is distinct from old.started_at then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: started_at não muda';
      end if;
      if old.status = 'expired' and new.status <> 'expired' then
        raise exception 'PAYMENT_REQUIRED' using detail = 'PAID_GUARD: assinatura vencida não volta';
      end if;
    end if;
    return new;
  end;
  $f$;

  drop trigger if exists trg_guard_paid_subscription on public.subscriptions;
  create trigger trg_guard_paid_subscription
  before insert or update on public.subscriptions
  for each row execute function public.guard_paid_subscription();


  -- ------------------------------------------------------------------------
  -- 5) PREÇO E PERÍODO -- a ÚNICA fonte (decisão pendente, ver cabeçalho)
  -- ------------------------------------------------------------------------
  -- Espelho de PLAN_PRICES em src/lib/plans.js (49/99). plans.test.js lê
  -- este arquivo e compara: mudar um sem o outro quebra o teste.
  create or replace function public.plan_price_cents(p_plan_id text)
   returns integer
   language sql
   immutable
  as $f$
    select case p_plan_id
      when 'basico' then 0
      when 'profissional' then 4900
      when 'premium' then 9900
    end;
  $f$;

  -- PROVISÓRIO: preço mensal cheio cobrindo até o próximo dia 10; fatura
  -- vence em hoje+3, nunca depois da véspera do fim do período, nunca antes
  -- de hoje (datas em America/Sao_Paulo). Única fonte de preço, período e
  -- vencimento -- a Edge Function só repassa (§232-233).
  -- (drop: a 1ª versão não devolvia due_date; o tipo de retorno mudou.)
  drop function if exists public.billing_quote(text, timestamptz);
  create function public.billing_quote(p_plan_id text, p_at timestamptz default now())
   returns table (amount_cents integer, covers_until timestamptz, billing_cycle date, due_date date)
   language sql
   stable
  -- 1ª cobrança (decisão do usuário, §241): faltando MENOS de 7 dias para o
  -- próximo dia 10, o pagamento cobre até o dia 10 do mês SEGUINTE -- quem
  -- assina dia 9 não paga um mês por 1 dia; ganha esses dias a mais.
  as $f$
    select public.plan_price_cents(p_plan_id),
           c.fim,
           (c.fim at time zone 'America/Sao_Paulo')::date,
           greatest((p_at at time zone 'America/Sao_Paulo')::date,
                    least((p_at at time zone 'America/Sao_Paulo')::date + 3,
                          (c.fim at time zone 'America/Sao_Paulo')::date - 1))
    from (select case when public.next_billing_date(p_at) - p_at < interval '7 days'
                      then public.next_billing_date(public.next_billing_date(p_at))
                      else public.next_billing_date(p_at) end as fim) c;
  $f$;


  -- ------------------------------------------------------------------------
  -- 6) CHECKOUT -- chamado pela Edge Function billing-checkout
  -- ------------------------------------------------------------------------
  create or replace function public.billing_prepare_checkout(p_uid uuid, p_plan_id text, p_environment text)
   returns jsonb
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_env text := public.billing_accepted_environment();
    v_type text;
    v_current text;
    v_p public.payments;
    v_q record;
    v_stale boolean;
  begin
    if p_uid is null then
      raise exception 'AUTH_REQUIRED';
    end if;
    if p_plan_id is null or p_plan_id not in ('profissional', 'premium') then
      raise exception 'INVALID_PLAN';
    end if;
    if v_env is null then
      raise exception 'BILLING_DISABLED';
    end if;
    if p_environment is distinct from v_env then
      raise exception 'ENVIRONMENT_MISMATCH';
    end if;

    select coalesce(up.user_type, u.raw_user_meta_data ->> 'user_type', u.raw_user_meta_data ->> 'role')
      into v_type
    from auth.users u
    left join public.user_profiles up on up.created_by = u.id
    where u.id = p_uid
    limit 1;
    if not found then
      raise exception 'ACCOUNT_NOT_FOUND';
    end if;
    if v_type is distinct from 'fornecedor' then
      raise exception 'NOT_A_SUPPLIER';
    end if;

    -- Mesma ordem de travas das RPCs de assinatura.
    perform public.lock_plan_account(p_uid);
    perform public.advance_subscription_state(p_uid);

    -- §234: com qualquer análise financeira ABERTA da conta (pago sem
    -- aplicar, pago depois de anulado, estado desconhecido no Asaas, órfã,
    -- divergência...) não nasce cobrança nova -- seriam duas pagáveis para
    -- o mesmo período. Libera quando a análise é resolvida: automaticamente
    -- (estorno/remoção/ativação confirmados pela reconsulta) ou pelo
    -- administrador (billing_review_resolve).
    if exists (select 1 from public.billing_reviews r where r.created_by = p_uid and r.resolved_at is null) then
      raise exception 'PAYMENT_UNDER_REVIEW';
    end if;

    v_current := public.fornecedor_current_plan_id(p_uid);
    if v_current is not null and v_current <> 'basico' then
      -- Upgrade entre pagos e renovação: decisão pendente.
      raise exception 'ALREADY_ON_PAID_PLAN';
    end if;

    select * into v_q from public.billing_quote(p_plan_id);
    if v_q.amount_cents is null or v_q.amount_cents <= 0 then
      raise exception 'INVALID_PLAN';
    end if;

    -- A pendente (no máximo UMA: payments_one_open_charge) decide a ação.
    -- O banco NÃO cancela nada sozinho: vencida -> 'check_stale', e a Edge
    -- Function consulta o Asaas (paga? removida? em aberto?) antes de
    -- encerrar; só depois disso uma nova pode nascer.
    select * into v_p from public.payments
    where created_by = p_uid and environment = v_env and status = 'pending'
    for update;
    if found then
      -- Alguém está criando a cobrança desta linha agora (dois checkouts).
      if v_p.gateway_payment_id is null and v_p.gateway_claim_until > now() then
        return jsonb_build_object('action', 'wait', 'payment_id', v_p.id);
      end if;

      v_stale := v_p.covers_until <= now()
              or v_p.covers_until is distinct from v_q.covers_until
              or coalesce(v_p.due_date, (now() at time zone 'America/Sao_Paulo')::date)
                 < (now() at time zone 'America/Sao_Paulo')::date;

      if v_stale then
        return jsonb_build_object('action', 'check_stale', 'payment_id', v_p.id, 'plan_id', v_p.plan_id,
          'gateway_payment_id', v_p.gateway_payment_id, 'amount_cents', v_p.amount_cents);
      end if;

      if v_p.plan_id = p_plan_id and v_p.amount_cents = v_q.amount_cents then
        if v_p.gateway_payment_id is not null then
          return jsonb_build_object('action', 'reuse', 'payment_id', v_p.id, 'plan_id', v_p.plan_id,
            'amount_cents', v_p.amount_cents, 'covers_until', v_p.covers_until, 'due_date', v_p.due_date,
            'gateway_payment_id', v_p.gateway_payment_id, 'invoice_url', v_p.invoice_url);
        end if;
        -- Ficou sem ligar (a criação anterior caiu no meio): retoma a
        -- reserva. A Edge Function procura por externalReference ANTES de
        -- criar, então uma cobrança que chegou a nascer no Asaas é achada.
        update public.payments set gateway_claim_until = now() + interval '2 minutes', updated_at = now()
        where id = v_p.id;
        return jsonb_build_object('action', 'create', 'payment_id', v_p.id, 'plan_id', v_p.plan_id,
          'amount_cents', v_p.amount_cents, 'covers_until', v_p.covers_until, 'due_date', v_p.due_date);
      end if;

      -- Outro plano com fatura ainda dentro do vencimento: decisão
      -- comercial pendente (trocar no meio?) -- continua bloqueado.
      raise exception 'PENDING_CHARGE_EXISTS' using detail = v_p.plan_id;
    end if;

    insert into public.payments (created_by, plan_id, billing_cycle, amount_cents, status, gateway,
                                 environment, covers_until, due_date, gateway_claim_until)
    values (p_uid, p_plan_id, v_q.billing_cycle, v_q.amount_cents, 'pending', 'asaas', v_env,
            v_q.covers_until, v_q.due_date, now() + interval '2 minutes')
    returning * into v_p;

    return jsonb_build_object('action', 'create', 'payment_id', v_p.id, 'plan_id', v_p.plan_id,
      'amount_cents', v_p.amount_cents, 'covers_until', v_p.covers_until, 'due_date', v_p.due_date);
  end;
  $f$;

  -- Pendente que NUNCA chegou ao Asaas (a Edge Function procurou por
  -- externalReference e não achou): encerra sem apagar. Só sem cobrança
  -- ligada e com a reserva vencida -- nunca uma criação em andamento.
  create or replace function public.billing_void_unattached(p_payment_id uuid)
   returns text
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_p public.payments;
  begin
    select * into v_p from public.payments where id = p_payment_id;
    if v_p.id is null then
      raise exception 'PAYMENT_NOT_FOUND';
    end if;
    perform public.lock_plan_account(v_p.created_by);
    select * into v_p from public.payments where id = p_payment_id for update;
    if v_p.status <> 'pending' or v_p.gateway_payment_id is not null then
      raise exception 'PAYMENT_NOT_VOIDABLE';
    end if;
    if v_p.gateway_claim_until > now() then
      raise exception 'CLAIM_ACTIVE';
    end if;
    update public.payments set status = 'refused', closed_reason = 'unattached_void', updated_at = now()
    where id = p_payment_id;
    return 'voided';
  end;
  $f$;

  -- Registro para análise manual. Idempotente (uma aberta por motivo+alvo).
  -- created_by: o dono do payment; sem payment, o informado (ex.: cobrança
  -- desconhecida de um CLIENTE nosso). Com created_by, a análise BLOQUEIA
  -- novo checkout da conta até ser resolvida (§234).
  drop function if exists public.billing_review_add(text, uuid, text, text, jsonb);
  create or replace function public.billing_review_add(
    p_reason text, p_payment_id uuid default null, p_gateway_payment_id text default null,
    p_event_id text default null, p_details jsonb default null, p_created_by uuid default null
  )
   returns void
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  begin
    insert into public.billing_reviews (created_by, payment_id, gateway_payment_id, event_id, reason, details)
    values (coalesce((select created_by from public.payments where id = p_payment_id), p_created_by),
            p_payment_id, p_gateway_payment_id, p_event_id, p_reason, p_details)
    on conflict do nothing;
  end;
  $f$;

  -- Resolução ADMINISTRATIVA (só service_role / SQL Editor): registra o que
  -- foi feito (ex.: 'reembolsado no painel do Asaas em 05/11'). Não mexe em
  -- assinatura nem em pagamento -- só libera o bloqueio do checkout.
  create or replace function public.billing_review_resolve(p_review_id uuid, p_resolution text)
   returns void
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  begin
    if p_resolution is null or length(btrim(p_resolution)) < 5 then
      raise exception 'RESOLUTION_REQUIRED';
    end if;
    update public.billing_reviews set resolved_at = now(), resolution = left(btrim(p_resolution), 500)
    where id = p_review_id and resolved_at is null;
    if not found then
      raise exception 'REVIEW_NOT_OPEN';
    end if;
  end;
  $f$;

  -- Resolução AUTOMÁTICA, só quando a reconsulta ao Asaas tornou o estado
  -- definitivo (estornado, removido, ativado, ou confirmado em aberto).
  -- Pago-sem-aplicar, pago-depois-de-anulado, órfã e divergências nunca
  -- se resolvem sozinhos: alguém tem de decidir.
  create or replace function public.billing_reviews_autoresolve(p_payment_id uuid, p_reasons text[], p_resolution text)
   returns void
   language sql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    update public.billing_reviews set resolved_at = now(), resolution = p_resolution
    where payment_id = p_payment_id and resolved_at is null
      and (p_reasons is null or reason = any (p_reasons));
  $f$;

  -- De quem é uma cobrança do Asaas? 'nexar' (id conhecido), 'nexar_orphan'
  -- (referência = um payment nosso), 'nexar_customer' (cliente Asaas nosso,
  -- cobrança desconhecida -- ambíguo) ou 'external' (nada liga ao NEXAR:
  -- outra integração da mesma conta Asaas).
  create or replace function public.billing_charge_ownership(
    p_environment text, p_gateway_payment_id text, p_external_reference text, p_customer_id text
  )
   returns table (owner text, created_by uuid, payment_id uuid)
   language sql
   stable security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    select x.owner, x.created_by, x.payment_id from (
      select 'nexar'::text, p.created_by, p.id, 1 as o from public.payments p
      where p.gateway = 'asaas' and p.gateway_payment_id = p_gateway_payment_id
      union all
      select 'nexar_orphan', p.created_by, p.id, 2 from public.payments p
      where p.id::text = p_external_reference
      union all
      select 'nexar_customer', c.user_id, null::uuid, 3 from public.billing_customers c
      where c.gateway = 'asaas' and c.environment = p_environment and c.gateway_customer_id = p_customer_id
      union all
      select 'external', null::uuid, null::uuid, 4
    ) x(owner, created_by, payment_id, o)
    order by o
    limit 1;
  $f$;

  create or replace function public.billing_customer_get(p_uid uuid, p_environment text)
   returns text
   language sql
   stable security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    select gateway_customer_id from public.billing_customers
    where user_id = p_uid and environment = p_environment and gateway = 'asaas';
  $f$;

  -- Primeiro a gravar vence; devolve o que ficou (corrida de dois checkouts).
  create or replace function public.billing_customer_save(p_uid uuid, p_environment text, p_customer_id text)
   returns text
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  begin
    if p_customer_id is null or btrim(p_customer_id) = '' then
      raise exception 'INVALID_CUSTOMER';
    end if;
    insert into public.billing_customers (user_id, environment, gateway, gateway_customer_id)
    values (p_uid, p_environment, 'asaas', p_customer_id)
    on conflict (user_id, environment, gateway) do nothing;
    return public.billing_customer_get(p_uid, p_environment);
  end;
  $f$;

  create or replace function public.billing_attach_gateway_charge(
    p_payment_id uuid, p_gateway_payment_id text, p_gateway_customer_id text, p_invoice_url text
  )
   returns void
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_p public.payments;
  begin
    select * into v_p from public.payments where id = p_payment_id for update;
    if v_p.id is null or v_p.status <> 'pending' then
      raise exception 'PAYMENT_NOT_ATTACHABLE';
    end if;
    if v_p.gateway_payment_id is not null and v_p.gateway_payment_id <> p_gateway_payment_id then
      raise exception 'PAYMENT_NOT_ATTACHABLE' using detail = 'já ligada a outra cobrança do gateway';
    end if;
    if p_gateway_customer_id is distinct from public.billing_customer_get(v_p.created_by, v_p.environment) then
      raise exception 'CUSTOMER_MISMATCH';
    end if;
    update public.payments
    set gateway_payment_id = p_gateway_payment_id,
        gateway_customer_id = p_gateway_customer_id,
        invoice_url = coalesce(p_invoice_url, invoice_url),
        gateway_status = coalesce(gateway_status, 'PENDING'),
        gateway_claim_until = null,
        updated_at = now()
    where id = p_payment_id;
  end;
  $f$;


  -- ------------------------------------------------------------------------
  -- 7) WEBHOOK -- idempotência por evento
  -- ------------------------------------------------------------------------
  -- 'process' = processar agora; 'duplicate' = já processado/ignorado.
  create or replace function public.billing_webhook_begin(p_event_id text, p_event_type text, p_payload jsonb)
   returns text
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_status text;
  begin
    if p_event_id is null or btrim(p_event_id) = '' then
      raise exception 'INVALID_EVENT';
    end if;
    insert into public.webhook_events (provider, event_id, event_type, payload)
    values ('asaas', p_event_id, coalesce(p_event_type, '?'), coalesce(p_payload, '{}'::jsonb))
    on conflict (provider, event_id) do nothing;

    select status into v_status from public.webhook_events
    where provider = 'asaas' and event_id = p_event_id
    for update;
    if v_status in ('processed', 'ignored') then
      return 'duplicate';
    end if;
    update public.webhook_events set process_attempts = least(process_attempts + 1, 32767)
    where provider = 'asaas' and event_id = p_event_id;
    return 'process';
  end;
  $f$;

  create or replace function public.billing_webhook_finish(p_event_id text, p_status text, p_error text default null)
   returns void
   language sql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    update public.webhook_events
    set status = p_status,
        processed_at = case when p_status in ('processed', 'ignored') then now() end,
        last_error = left(p_error, 500)
    where provider = 'asaas' and event_id = p_event_id;
  $f$;

  -- RECONCILIAÇÃO (§233): o que re-consultar no Asaas quando o webhook não
  -- resolveu -- eventos 'pending'/'failed' parados (o Asaas desiste depois
  -- de 15 falhas seguidas ou 14 dias) e pendentes ligadas sem notícia há
  -- 15 min (fila pausada, webhook nunca chegou). Só lê. Quem re-consulta e
  -- aplica é a Edge Function billing-reconcile, pelo mesmo
  -- billing_apply_gateway_payment do webhook.
  -- (drop: a versão do §233 não devolvia as pistas; o tipo de retorno mudou.)
  -- hint_*: referência e cliente para classificar a propriedade se o Asaas
  -- responder 404 -- do evento gravado (já autenticado) ou do nosso payment.
  -- Sem elas, uma órfã viraria "externa" e o evento seria descartado.
  drop function if exists public.billing_reconcile_candidates(integer);
  create function public.billing_reconcile_candidates(p_limit integer default 50)
   returns table (kind text, event_id text, gateway_payment_id text, hint_external_reference text, hint_customer text)
   language sql
   stable security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    (select 'event'::text, w.event_id, w.payload -> 'payment' ->> 'id',
            w.payload -> 'payment' ->> 'externalReference', w.payload -> 'payment' ->> 'customer'
     from public.webhook_events w
     where w.provider = 'asaas' and w.status in ('pending', 'failed')
       and w.received_at < now() - interval '2 minutes'
       and w.received_at > now() - interval '30 days'
       and w.payload -> 'payment' ->> 'id' is not null
     order by w.received_at
     limit greatest(p_limit, 0))
    union all
    (select 'payment'::text, null, p.gateway_payment_id, p.id::text, p.gateway_customer_id
     from public.payments p
     where p.gateway = 'asaas' and p.status = 'pending' and p.gateway_payment_id is not null
       and p.environment = public.billing_accepted_environment()
       and p.updated_at < now() - interval '15 minutes'
     order by p.updated_at
     limit greatest(p_limit, 0))
    union all
    -- §234: cobranças nossas com estado DESCONHECIDO (404 ao reconsultar,
    -- remoção não confirmada) -- a reconsulta pode resolver a análise.
    (select 'payment'::text, null, p.gateway_payment_id, p.id::text, p.gateway_customer_id
     from public.billing_reviews r
     join public.payments p on p.id = r.payment_id
     where r.resolved_at is null
       and r.reason in ('CHARGE_STATE_UNKNOWN', 'REFETCH_FAILED_404', 'STALE_NOT_REMOVED',
                        'ATTACH_FAILED', 'STALE_ATTACH_FAILED')
       and r.created_at > now() - interval '30 days'   -- depois disso, só o admin
       and p.gateway_payment_id is not null
       and p.environment = public.billing_accepted_environment()
     order by r.created_at
     limit greatest(p_limit, 0));
  $f$;

  -- Execuções da reconciliação (§234): uma por vez, com registro.
  create table if not exists public.billing_reconcile_runs (
    id uuid primary key default gen_random_uuid(),
    source text not null default 'manual',
    status text not null default 'running' check (status in ('running', 'done', 'failed', 'aborted')),
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    stats jsonb,
    error text
  );
  alter table public.billing_reconcile_runs enable row level security;
  revoke all on public.billing_reconcile_runs from public, anon, authenticated;

  -- Abre uma execução, ou devolve NULL se outra está rodando (concorrência).
  -- Uma 'running' mais velha que p_lease_seconds morreu no meio: vira
  -- 'aborted' e a vaga é liberada. Histórico de 30 dias.
  create or replace function public.billing_reconcile_begin(p_source text default 'manual', p_lease_seconds integer default 600)
   returns uuid
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_id uuid;
  begin
    perform pg_advisory_xact_lock(hashtextextended('nexar:billing-reconcile', 0));
    update public.billing_reconcile_runs set status = 'aborted', finished_at = now(), error = 'lease expirado'
    where status = 'running' and started_at < now() - make_interval(secs => greatest(p_lease_seconds, 60));
    if exists (select 1 from public.billing_reconcile_runs where status = 'running') then
      return null;
    end if;
    delete from public.billing_reconcile_runs where started_at < now() - interval '30 days';
    insert into public.billing_reconcile_runs (source) values (left(coalesce(p_source, 'manual'), 40))
    returning id into v_id;
    return v_id;
  end;
  $f$;

  create or replace function public.billing_reconcile_finish(p_run_id uuid, p_status text, p_stats jsonb, p_error text default null)
   returns void
   language sql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
    update public.billing_reconcile_runs
    set status = case when p_status in ('done', 'failed') then p_status else 'failed' end,
        finished_at = now(), stats = p_stats, error = left(p_error, 500)
    where id = p_run_id and status = 'running';
  $f$;


  -- ------------------------------------------------------------------------
  -- 8) O NÚCLEO: aplicar o estado (RE-CONSULTADO no Asaas) de uma cobrança
  --
  -- Os parâmetros vêm do GET /v3/payments/{id} que a Edge Function faz no
  -- Asaas -- não do corpo do webhook. Mesmo assim nada aqui confia neles
  -- sozinho: a cobrança tem de ter sido criada por este sistema
  -- (gateway_payment_id conhecido), e cliente, externalReference (= o id
  -- do payment), valor em centavos e ambiente têm de bater.
  -- ------------------------------------------------------------------------
  create or replace function public.billing_apply_gateway_payment(
    p_environment text, p_gateway_payment_id text, p_gateway_status text,
    p_value numeric, p_customer_id text, p_external_reference text, p_deleted boolean default false
  )
   returns jsonb
   language plpgsql
   security definer
   set search_path to 'public', 'pg_temp'
  as $f$
  declare
    v_env text := public.billing_accepted_environment();
    v_p public.payments;
    v_cur public.subscriptions;
    v_sub public.subscriptions;
    v_reason text;
    v_cents numeric;
    v_kind text;
    v_own record;
    -- Motivos que a reconsulta resolve sozinha (o estado ficou conhecido).
    -- ATTACH_FAILED / STALE_ATTACH_FAILED também: se chegamos até aqui
    -- achando o payment pelo gateway_payment_id, a ligação EXISTE (a
    -- resposta da ligação é que se perdeu) -- sem isto a conta ficava
    -- bloqueada só por admin, sem acesso à própria fatura (§234).
    v_estado text[] := array['CHARGE_STATE_UNKNOWN', 'REFETCH_FAILED_404', 'STALE_NOT_REMOVED',
                             'ATTACH_FAILED', 'STALE_ATTACH_FAILED'];
  begin
    if v_env is null or p_environment is distinct from v_env then
      return jsonb_build_object('result', 'rejected', 'reason', 'ENVIRONMENT_MISMATCH');
    end if;

    select * into v_p from public.payments
    where gateway = 'asaas' and gateway_payment_id = p_gateway_payment_id;
    if v_p.id is null then
      -- Cobrança que não é nossa. Nunca ativa. Comprovadamente EXTERNA (nem
      -- referência nem cliente ligam ao NEXAR -- outra integração da mesma
      -- conta Asaas): recusa sem análise (o webhook_event fica de
      -- auditoria). Órfã (referência = um payment nosso) ou cobrança
      -- desconhecida de um CLIENTE nosso: ambígua -> análise manual.
      select * into v_own from public.billing_charge_ownership(p_environment, p_gateway_payment_id,
                                                             p_external_reference, p_customer_id);
      if v_own.owner = 'external' then
        return jsonb_build_object('result', 'rejected', 'reason', 'EXTERNAL_CHARGE');
      end if;
      perform public.billing_review_add(
        case v_own.owner when 'nexar_orphan' then 'ORPHAN_GATEWAY_CHARGE' else 'UNKNOWN_CHARGE_NEXAR_CUSTOMER' end,
        v_own.payment_id, p_gateway_payment_id, null,
        jsonb_build_object('gateway_status', p_gateway_status, 'value', p_value, 'customer', p_customer_id),
        v_own.created_by);
      return jsonb_build_object('result', 'rejected', 'reason', 'UNKNOWN_CHARGE');
    end if;

    -- Travas na ordem de sempre: conta -> resto.
    perform public.lock_plan_account(v_p.created_by);
    select * into v_p from public.payments where id = v_p.id for update;

    v_cents := p_value * 100;
    v_reason := case
      when v_p.environment is distinct from p_environment then 'ENVIRONMENT_MISMATCH'
      when p_external_reference is distinct from v_p.id::text then 'EXTERNAL_REFERENCE_MISMATCH'
      when p_customer_id is distinct from v_p.gateway_customer_id then 'CUSTOMER_MISMATCH'
      when v_cents is null or v_cents <> trunc(v_cents) or v_cents::integer <> v_p.amount_cents then 'AMOUNT_MISMATCH'
    end;
    if v_reason is not null then
      insert into public.subscription_events (created_by, event_type, to_plan, metadata)
      values (v_p.created_by, 'payment_rejected', v_p.plan_id,
              jsonb_build_object('payment_id', v_p.id, 'reason', v_reason, 'gateway_status', p_gateway_status));
      perform public.billing_review_add(v_reason, v_p.id, p_gateway_payment_id, null,
        jsonb_build_object('gateway_status', p_gateway_status, 'value', p_value, 'customer', p_customer_id,
                           'external_reference', p_external_reference));
      return jsonb_build_object('result', 'rejected', 'reason', v_reason, 'payment_id', v_p.id);
    end if;

    v_kind := case
      when coalesce(p_deleted, false) then 'deleted'
      when p_gateway_status in ('CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH') then 'paid'
      when p_gateway_status in ('REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED',
                                'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL') then 'reversed'
      else 'open'
    end;

    update public.payments set gateway_status = p_gateway_status, updated_at = now() where id = v_p.id;

    -- -------- ESTORNO / CHARGEBACK: o benefício acaba agora (decisão pendente) --------
    if v_kind = 'reversed' then
      -- Só REFUNDED (dinheiro devolvido) é definitivo: fecha TODAS as
      -- análises desse pagamento (inclusive pago-sem-aplicar) e libera o
      -- checkout. Pedido de estorno / chargeback em disputa não fecham nada.
      if p_gateway_status = 'REFUNDED' then
        perform public.billing_reviews_autoresolve(v_p.id, null, 'auto:estornado no Asaas');
      end if;
      if v_p.status = 'refunded' then
        return jsonb_build_object('result', 'already_reversed', 'payment_id', v_p.id);
      end if;
      update public.payments set status = 'refunded', refunded_at = now() where id = v_p.id;
      if v_p.consumed_at is not null then
        update public.subscriptions
        set status = 'expired', expires_at = least(expires_at, now()), next_charge_at = null
        where payment_id = v_p.id and status in ('active', 'cancelled');
        perform public.apply_plan_limits_safe(v_p.created_by, 'billing:reversal');
      end if;
      insert into public.subscription_events (created_by, event_type, to_plan, metadata)
      values (v_p.created_by, 'payment_reversed', v_p.plan_id,
              jsonb_build_object('payment_id', v_p.id, 'gateway_status', p_gateway_status));
      return jsonb_build_object('result', 'reversed', 'payment_id', v_p.id);
    end if;

    -- -------- REMOVIDA no Asaas antes de pagar --------
    if v_kind = 'deleted' then
      if v_p.status = 'pending' then
        -- A linha fica (auditoria); só sai de 'pending', o que libera a
        -- próxima cobrança da conta.
        update public.payments set status = 'refused', closed_reason = 'deleted_at_gateway' where id = v_p.id;
        perform public.billing_reviews_autoresolve(v_p.id,
          v_estado || array['ATTACH_FAILED', 'STALE_ATTACH_FAILED'], 'auto:removida confirmada no Asaas');
        return jsonb_build_object('result', 'voided', 'payment_id', v_p.id);
      end if;
      return jsonb_build_object('result', 'ignored', 'reason', 'DELETED_AFTER_' || upper(v_p.status), 'payment_id', v_p.id);
    end if;

    -- -------- EM ABERTO (PENDING, OVERDUE, análise de risco...) --------
    if v_kind = 'open' then
      -- §235: anulada por nós e de novo "em aberto" no Asaas = RESTAURADA
      -- no painel ("uma cobrança removida pode ser restaurada com o mesmo
      -- ID"). Volta a ser pagável ao lado da nova: análise, que bloqueia
      -- novo checkout da conta. Não reabre a linha local.
      if v_p.status = 'refused' and v_p.closed_reason is not null then
        perform public.billing_review_add('RESTORED_AFTER_VOID', v_p.id, p_gateway_payment_id, null,
          jsonb_build_object('closed_reason', v_p.closed_reason, 'gateway_status', p_gateway_status));
        return jsonb_build_object('result', 'ignored', 'reason', 'RESTORED_AFTER_VOID', 'payment_id', v_p.id);
      end if;
      if v_p.status <> 'pending' then
        -- Fora de ordem: um pago/estornado nunca volta a "em aberto".
        return jsonb_build_object('result', 'ignored', 'reason', 'OUT_OF_ORDER', 'payment_id', v_p.id);
      end if;
      -- A reconsulta achou a cobrança, em aberto: o estado deixou de ser
      -- desconhecido.
      perform public.billing_reviews_autoresolve(v_p.id, v_estado, 'auto:em aberto confirmado no Asaas');
      return jsonb_build_object('result', 'pending', 'payment_id', v_p.id);
    end if;

    -- -------- PAGO (CONFIRMED / RECEIVED: dois eventos, um benefício) --------
    if v_p.status = 'refunded' then
      return jsonb_build_object('result', 'ignored', 'reason', 'ALREADY_REVERSED', 'payment_id', v_p.id);
    end if;
    if v_p.consumed_at is not null then
      return jsonb_build_object('result', 'already_applied', 'payment_id', v_p.id);
    end if;
    if v_p.status = 'refused' then
      -- Pago depois de anulada (corrida com a substituição): o dinheiro
      -- entrou, então aprova -- e sinaliza. Se já houver outro plano pago
      -- vigente, cai em PAID_PLAN_ALREADY_ACTIVE abaixo: um benefício só.
      perform public.billing_review_add('PAID_AFTER_VOID', v_p.id, p_gateway_payment_id, null,
        jsonb_build_object('closed_reason', v_p.closed_reason, 'gateway_status', p_gateway_status));
    end if;
    if v_p.status <> 'approved' then
      update public.payments set status = 'approved', paid_at = coalesce(paid_at, now()) where id = v_p.id;
      v_p.status := 'approved';
    end if;
    if v_p.unapplied_reason is not null then
      return jsonb_build_object('result', 'approved_unapplied', 'reason', v_p.unapplied_reason, 'payment_id', v_p.id);
    end if;

    perform public.advance_subscription_state(v_p.created_by);

    v_reason := null;
    if v_p.covers_until <= now() then
      v_reason := 'LATE_PAYMENT';                 -- pagou depois do fim do período
    else
      select * into v_cur from public.subscriptions
      where created_by = v_p.created_by and status in ('active', 'cancelled')
        and started_at <= now() and expires_at > now()
      order by started_at desc limit 1;
      if v_cur.id is not null and v_cur.plan_id <> 'basico' then
        v_reason := 'PAID_PLAN_ALREADY_ACTIVE';   -- não empilha períodos
      end if;
    end if;
    if v_reason is not null then
      update public.payments set unapplied_reason = v_reason where id = v_p.id;
      -- Dinheiro entrou e nada foi concedido: alguém precisa decidir
      -- (reembolso? aplicar à mão?). Decisão comercial pendente (§232).
      perform public.billing_review_add('PAYMENT_UNAPPLIED_' || v_reason, v_p.id, p_gateway_payment_id, null,
        jsonb_build_object('amount_cents', v_p.amount_cents, 'covers_until', v_p.covers_until));
      insert into public.subscription_events (created_by, event_type, to_plan, metadata)
      values (v_p.created_by, 'payment_unapplied', v_p.plan_id,
              jsonb_build_object('payment_id', v_p.id, 'reason', v_reason));
      return jsonb_build_object('result', 'approved_unapplied', 'reason', v_reason, 'payment_id', v_p.id);
    end if;

    -- Ativa: sai o Básico (se houver), entra o pago até covers_until.
    delete from public.subscriptions where created_by = v_p.created_by and status = 'scheduled';
    if v_cur.id is not null then
      update public.subscriptions set status = 'expired', expires_at = now(), next_charge_at = null
      where id = v_cur.id;
    end if;

    insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at,
                                      next_charge_at, first_cycle_partial, partial_days, payment_id)
    values (v_p.created_by, v_p.plan_id, 'active', now(), v_p.covers_until, null, false, null, v_p.id)
    returning * into v_sub;

    update public.payments set consumed_at = now(), subscription_id = v_sub.id where id = v_p.id;

    insert into public.subscription_events (created_by, subscription_id, event_type, to_plan, metadata)
    values (v_p.created_by, v_sub.id, 'payment_applied', v_p.plan_id,
            jsonb_build_object('payment_id', v_p.id, 'amount_cents', v_p.amount_cents,
                               'covers_until', v_p.covers_until, 'gateway_status', p_gateway_status));

    perform public.apply_plan_limits_safe(v_p.created_by, 'billing:activation');

    perform public.billing_reviews_autoresolve(v_p.id, v_estado, 'auto:pagamento aplicado');
    return jsonb_build_object('result', 'activated', 'payment_id', v_p.id, 'subscription_id', v_sub.id,
                              'plan_id', v_sub.plan_id, 'expires_at', v_sub.expires_at);
  end;
  $f$;


  -- ------------------------------------------------------------------------
  -- 9) PERMISSÕES -- nada disto é do cliente
  -- ------------------------------------------------------------------------
  revoke all on function public.billing_accepted_environment() from public, anon, authenticated;
  revoke all on function public.guard_paid_subscription() from public, anon, authenticated;
  revoke all on function public.plan_price_cents(text) from public, anon, authenticated;
  revoke all on function public.billing_quote(text, timestamptz) from public, anon, authenticated;
  revoke all on function public.billing_prepare_checkout(uuid, text, text) from public, anon, authenticated;
  revoke all on function public.billing_customer_get(uuid, text) from public, anon, authenticated;
  revoke all on function public.billing_customer_save(uuid, text, text) from public, anon, authenticated;
  revoke all on function public.billing_attach_gateway_charge(uuid, text, text, text) from public, anon, authenticated;
  revoke all on function public.billing_webhook_begin(text, text, jsonb) from public, anon, authenticated;
  revoke all on function public.billing_webhook_finish(text, text, text) from public, anon, authenticated;
  revoke all on function public.billing_apply_gateway_payment(text, text, text, numeric, text, text, boolean) from public, anon, authenticated;
  revoke all on function public.billing_void_unattached(uuid) from public, anon, authenticated;
  revoke all on function public.billing_review_add(text, uuid, text, text, jsonb, uuid) from public, anon, authenticated;
  revoke all on function public.billing_review_resolve(uuid, text) from public, anon, authenticated;
  revoke all on function public.billing_reviews_autoresolve(uuid, text[], text) from public, anon, authenticated;
  revoke all on function public.billing_charge_ownership(text, text, text, text) from public, anon, authenticated;
  revoke all on function public.billing_reconcile_candidates(integer) from public, anon, authenticated;
  revoke all on function public.billing_reconcile_begin(text, integer) from public, anon, authenticated;
  revoke all on function public.billing_reconcile_finish(uuid, text, jsonb, text) from public, anon, authenticated;
  grant execute on function public.billing_void_unattached(uuid) to service_role;
  grant execute on function public.billing_review_add(text, uuid, text, text, jsonb, uuid) to service_role;
  grant execute on function public.billing_review_resolve(uuid, text) to service_role;
  grant execute on function public.billing_charge_ownership(text, text, text, text) to service_role;
  grant execute on function public.billing_reconcile_candidates(integer) to service_role;
  grant execute on function public.billing_reconcile_begin(text, integer) to service_role;
  grant execute on function public.billing_reconcile_finish(uuid, text, jsonb, text) to service_role;

  grant execute on function public.billing_prepare_checkout(uuid, text, text) to service_role;
  grant execute on function public.billing_customer_get(uuid, text) to service_role;
  grant execute on function public.billing_customer_save(uuid, text, text) to service_role;
  grant execute on function public.billing_attach_gateway_charge(uuid, text, text, text) to service_role;
  grant execute on function public.billing_webhook_begin(text, text, jsonb) to service_role;
  grant execute on function public.billing_webhook_finish(text, text, text) to service_role;
  grant execute on function public.billing_apply_gateway_payment(text, text, text, numeric, text, text, boolean) to service_role;


  -- ------------------------------------------------------------------------
  -- 10) TESTES -- cada um num sub-bloco que termina SEMPRE em exceção
  --     (nada fica: linhas, eventos, notificações, e-mails, config, role).
  --     Dentro de cada sub-bloco o ambiente aceito vira 'sandbox' só para o
  --     teste; fora dele continua o que estava (NULL no banco real).
  -- ------------------------------------------------------------------------
  create or replace function pg_temp.bl_conta(p_tipo text, p_n int default 0)
   returns uuid
   language plpgsql
  as $f$
  declare
    v uuid := gen_random_uuid();
  begin
    begin
      insert into auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
      values (v, 'bl-' || p_tipo || '-' || left(v::text, 8) || '@nexar.test', 'authenticated', 'authenticated',
              jsonb_build_object('role', p_tipo, 'user_type', p_tipo), '{}'::jsonb, now(), now());
    exception when others then
      -- Banco não deixa criar conta: usa uma existente do tipo pedido, só
      -- dentro do sub-bloco (desfeito).
      select up.created_by into v from public.user_profiles up
      where up.user_type = p_tipo and up.created_by is not null
      order by up.created_by offset p_n limit 1;
      if v is null then
        raise exception 'BL_SEM_CONTA: não deu para criar conta (%) nem há conta % existente', sqlerrm, p_tipo;
      end if;
      delete from public.subscriptions where created_by = v;
      -- billing_reviews referencia payments (sem cascata): primeiro elas.
      delete from public.billing_reviews where created_by = v
        or payment_id in (select id from public.payments where created_by = v);
      delete from public.payments where created_by = v;
      delete from public.billing_customers where user_id = v;
    end;
    return v;
  end;
  $f$;

  -- Cobrança como a Edge Function faria: prepara + cliente + liga ao gateway.
  create or replace function pg_temp.bl_cobranca(p_uid uuid, p_plan text)
   returns public.payments
   language plpgsql
  as $f$
  declare
    v_j jsonb;
    v_p public.payments;
  begin
    v_j := public.billing_prepare_checkout(p_uid, p_plan, 'sandbox');
    perform public.billing_customer_save(p_uid, 'sandbox', 'cus_t_' || left(p_uid::text, 8));
    perform public.billing_attach_gateway_charge((v_j ->> 'payment_id')::uuid,
      'pay_t_' || left((v_j ->> 'payment_id'), 8), 'cus_t_' || left(p_uid::text, 8), 'https://sandbox.asaas.com/i/t');
    select * into v_p from public.payments where id = (v_j ->> 'payment_id')::uuid;
    return v_p;
  end;
  $f$;

  create or replace function pg_temp.bl_aplicar(p public.payments, p_status text, p_value numeric default null,
                                               p_customer text default null, p_ref text default null,
                                               p_env text default 'sandbox', p_deleted boolean default false)
   returns text
   language sql
  as $f$
    select coalesce(r ->> 'result', '?') || coalesce(':' || (r ->> 'reason'), '')
    from (select public.billing_apply_gateway_payment(
            p_env, p.gateway_payment_id, p_status, coalesce(p_value, p.amount_cents / 100.0),
            coalesce(p_customer, p.gateway_customer_id), coalesce(p_ref, p.id::text), p_deleted) as r) x;
  $f$;

  create or replace function pg_temp.bl_registrar(p_teste text, p_esperado text, p_obtido text)
   returns void
   language sql
  as $f$
    insert into _bl_testes values (p_teste, p_esperado, p_obtido, p_obtido = p_esperado);
  $f$;

  declare
    v_me text := current_user;
    v_a uuid;
    v_b uuid;
    v_p public.payments;
    v_q public.payments;
    v_s public.subscriptions;
    v_res text;
    v_err text;
    v_n int;
  begin
    -- B1. Pendente / vencida / em análise não ativa.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_a, 'premium');
      v_res := pg_temp.bl_aplicar(v_p, 'PENDING') || ',' || pg_temp.bl_aplicar(v_p, 'OVERDUE') || ','
               || pg_temp.bl_aplicar(v_p, 'AWAITING_RISK_ANALYSIS');
      raise exception 'FIM:%', v_res || format('/plano=%s/status=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'),
        (select status from public.payments where id = v_p.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B1 pendente/vencida/análise não ativa', 'pending,pending,pending/plano=nenhum/status=pending', v_res);

    -- B2. Removida no Asaas antes de pagar: anula, não ativa.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_a, 'profissional');
      v_res := pg_temp.bl_aplicar(v_p, 'PENDING', p_deleted => true);
      raise exception 'FIM:%', v_res || format('/plano=%s/status=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'),
        (select status from public.payments where id = v_p.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B2 removida antes de pagar', 'voided/plano=nenhum/status=refused', v_res);

    -- B3. Confirmação válida (com Básico vigente): ativa o plano e período certos.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
      values (v_a, 'basico', 'active', now() - interval '1 day', 'infinity');
      v_p := pg_temp.bl_cobranca(v_a, 'profissional');
      v_res := pg_temp.bl_aplicar(v_p, 'CONFIRMED');
      select * into v_s from public.subscriptions where created_by = v_a and status = 'active';
      select * into v_q from public.payments where id = v_p.id;
      raise exception 'FIM:%', v_res || format('/plano=%s/expira=quote:%s/pagamento=%s,consumido:%s/basico=%s/valor=%s',
        public.fornecedor_current_plan_id(v_a),
        (v_s.expires_at = (select covers_until from public.billing_quote('profissional')))::text,
        v_q.status, (v_q.consumed_at is not null)::text,
        (select status from public.subscriptions where created_by = v_a and plan_id = 'basico'),
        v_q.amount_cents);
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B3 confirmação válida ativa plano e período',
      'activated/plano=profissional/expira=quote:true/pagamento=approved,consumido:true/basico=expired/valor=4900', v_res);

    -- B4. Duplicado: RECEIVED depois de CONFIRMED, e o mesmo de novo.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_a, 'premium');
      v_res := pg_temp.bl_aplicar(v_p, 'CONFIRMED');
      select * into v_s from public.subscriptions where created_by = v_a and status = 'active';
      v_res := v_res || ',' || pg_temp.bl_aplicar(v_p, 'RECEIVED') || ',' || pg_temp.bl_aplicar(v_p, 'RECEIVED');
      raise exception 'FIM:%', v_res || format('/assinaturas_pagas=%s/expira_igual=%s/eventos_aplicados=%s',
        (select count(*) from public.subscriptions where created_by = v_a and plan_id <> 'basico'),
        ((select expires_at from public.subscriptions where id = v_s.id) = v_s.expires_at)::text,
        (select count(*) from public.subscription_events where created_by = v_a and event_type = 'payment_applied'));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B4 evento duplicado não concede de novo',
      'activated,already_applied,already_applied/assinaturas_pagas=1/expira_igual=true/eventos_aplicados=1', v_res);

    -- B5. Divergências: outra conta, referência, valor, ambiente, cobrança desconhecida.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor', 0);
      v_b := pg_temp.bl_conta('fornecedor', 1);
      v_p := pg_temp.bl_cobranca(v_a, 'premium');
      v_q := pg_temp.bl_cobranca(v_b, 'profissional');
      v_res := pg_temp.bl_aplicar(v_p, 'RECEIVED', p_customer => v_q.gateway_customer_id) || ','
            || pg_temp.bl_aplicar(v_p, 'RECEIVED', p_ref => v_q.id::text) || ','
            || pg_temp.bl_aplicar(v_p, 'RECEIVED', p_value => 9.90) || ','
            || pg_temp.bl_aplicar(v_p, 'RECEIVED', p_value => 99.001) || ','
            || pg_temp.bl_aplicar(v_p, 'RECEIVED', p_env => 'production') || ','
            || coalesce(public.billing_apply_gateway_payment('sandbox', 'pay_forjado', 'RECEIVED', 99, v_p.gateway_customer_id, v_p.id::text) ->> 'reason', '?');
      raise exception 'FIM:%', v_res || format('/planos=%s,%s/status=%s',
        coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'), coalesce(public.fornecedor_current_plan_id(v_b), 'nenhum'),
        (select status from public.payments where id = v_p.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B5 outra conta/referência/valor/ambiente/desconhecida',
      'rejected:CUSTOMER_MISMATCH,rejected:EXTERNAL_REFERENCE_MISMATCH,rejected:AMOUNT_MISMATCH,rejected:AMOUNT_MISMATCH,rejected:ENVIRONMENT_MISMATCH,UNKNOWN_CHARGE/planos=nenhum,nenhum/status=pending',
      v_res);

    -- B6. Gravar assinatura paga DIRETO (como um corpo antigo faria) é recusado.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor', 0);
      v_b := pg_temp.bl_conta('fornecedor', 1);
      v_res := '';
      begin
        insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
        values (v_a, 'premium', 'active', now(), now() + interval '30 days');
        v_res := v_res || 'sem_pagamento=PASSOU;';
      exception when others then v_res := v_res || 'sem_pagamento=' || sqlerrm || ';';
      end;
      v_q := pg_temp.bl_cobranca(v_b, 'premium');
      perform pg_temp.bl_aplicar(v_q, 'RECEIVED');            -- B ativa (consome)
      begin
        insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, payment_id)
        -- Vencimento = o fim do período pago (um "+1 dia" passava do dia 10
        -- quando o teste rodava no dia 9 e o gatilho recusava antes do
        -- índice -- teste dependente da data, achado no projeto de teste).
        values (v_a, 'premium', 'active', now(), v_q.covers_until, v_q.id);
        v_res := v_res || 'pagamento_de_outra=PASSOU;';
      exception when others then v_res := v_res || 'pagamento_de_outra=' || sqlerrm || ';';
      end;
      begin
        insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, payment_id)
        values (v_b, 'premium', 'active', now(), v_q.covers_until, v_q.id);
        v_res := v_res || 'reusar_pagamento=PASSOU;';
      exception when others then v_res := v_res || 'reusar_pagamento=' || sqlstate || ';';
      end;
      begin
        insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
        values (v_a, 'profissional', 'scheduled', now() + interval '1 day', now() + interval '31 days');
        v_res := v_res || 'agendada_paga=PASSOU;';
      exception when others then v_res := v_res || 'agendada_paga=' || sqlerrm || ';';
      end;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B6 escrita direta de assinatura paga',
      'sem_pagamento=PAYMENT_REQUIRED;pagamento_de_outra=PAYMENT_REQUIRED;reusar_pagamento=23505;agendada_paga=PAYMENT_REQUIRED;', v_res);

    -- B7. Linha paga existente sem payment_id (as contas de 10/11): cancelar,
    --     reativar e vencer funcionam; estender ou subir de plano, não.
    begin
      v_a := pg_temp.bl_conta('fornecedor');
      alter table public.subscriptions disable trigger trg_guard_paid_subscription;  -- só para montar a linha legada
      insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, next_charge_at)
      values (v_a, 'profissional', 'active', now() - interval '20 days', now() + interval '5 days', now() + interval '5 days')
      returning * into v_s;
      alter table public.subscriptions enable trigger trg_guard_paid_subscription;
      perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      perform public.cancel_my_subscription();
      perform public.reactivate_my_subscription();
      perform set_config('role', v_me, true);
      v_res := 'cancelar_reativar=ok;';
      begin
        update public.subscriptions set expires_at = expires_at + interval '30 days' where id = v_s.id;
        v_res := v_res || 'estender=PASSOU;';
      exception when others then v_res := v_res || 'estender=' || sqlerrm || ';';
      end;
      begin
        update public.subscriptions set plan_id = 'premium' where id = v_s.id;
        v_res := v_res || 'subir=PASSOU;';
      exception when others then v_res := v_res || 'subir=' || sqlerrm || ';';
      end;
      update public.subscriptions set expires_at = now() - interval '1 second' where id = v_s.id;
      perform public.sync_subscription_for(v_a, 'teste_billing');
      begin
        update public.subscriptions set status = 'active' where id = v_s.id;
        v_res := v_res || 'ressuscitar=PASSOU;';
      exception when others then v_res := v_res || 'ressuscitar=' || sqlerrm || ';';
      end;
      raise exception 'FIM:%', v_res || format('vencida=%s', (select status from public.subscriptions where id = v_s.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B7 linha paga legada: cancelar/reativar/vencer sim, estender/subir não',
      'cancelar_reativar=ok;estender=PAYMENT_REQUIRED;subir=PAYMENT_REQUIRED;ressuscitar=PAYMENT_REQUIRED;vencida=expired', v_res);

    -- B8. Estorno depois de ativar: benefício acaba; nova confirmação não reativa.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_a, 'premium');
      v_res := pg_temp.bl_aplicar(v_p, 'RECEIVED') || ',' || pg_temp.bl_aplicar(v_p, 'REFUNDED') || ','
            || pg_temp.bl_aplicar(v_p, 'RECEIVED') || ',' || pg_temp.bl_aplicar(v_p, 'CHARGEBACK_REQUESTED');
      raise exception 'FIM:%', v_res || format('/plano=%s/status=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'),
        (select status from public.payments where id = v_p.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B8 estorno encerra; reconfirmação não reativa',
      'activated,reversed,ignored:ALREADY_REVERSED,already_reversed/plano=nenhum/status=refunded', v_res);

    -- B9. Pago depois do fim do período: aprovado, NÃO aplicado.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_a, 'profissional');
      update public.payments set covers_until = now() - interval '1 minute' where id = v_p.id;
      v_res := pg_temp.bl_aplicar(v_p, 'RECEIVED') || ',' || pg_temp.bl_aplicar(v_p, 'RECEIVED');
      raise exception 'FIM:%', v_res || format('/plano=%s/status=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'),
        (select status from public.payments where id = v_p.id));
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B9 pagamento atrasado: aprovado sem aplicar',
      'approved_unapplied:LATE_PAYMENT,approved_unapplied:LATE_PAYMENT/plano=nenhum/status=approved', v_res);

    -- B10. Cobrança desligada (ambiente NULL) e ambiente errado.
    begin
      update public.billing_config set accepted_environment = null;
      v_a := pg_temp.bl_conta('fornecedor');
      begin
        perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := 'desligada=PASSOU;';
      exception when others then v_res := 'desligada=' || sqlerrm || ';';
      end;
      update public.billing_config set accepted_environment = 'production';
      begin
        perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := v_res || 'ambiente=PASSOU;';
      exception when others then v_res := v_res || 'ambiente=' || sqlerrm || ';';
      end;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B10 cobrança desligada / ambiente errado',
      'desligada=BILLING_DISABLED;ambiente=ENVIRONMENT_MISMATCH;', v_res);

    -- B11. Checkout: cliente não compra; quem já tem pago não empilha;
    --      clique repetido reaproveita; outro plano com cobrança aberta, não.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('cliente');
      v_res := '';
      begin
        perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := 'cliente=PASSOU;';
      exception when others then v_res := 'cliente=' || sqlerrm || ';';
      end;
      v_b := pg_temp.bl_conta('fornecedor');
      v_p := pg_temp.bl_cobranca(v_b, 'premium');
      v_res := v_res || 'repetido=' || (public.billing_prepare_checkout(v_b, 'premium', 'sandbox') ->> 'action') || ';';
      begin
        perform public.billing_prepare_checkout(v_b, 'profissional', 'sandbox');
        v_res := v_res || 'outro_plano=PASSOU;';
      exception when others then v_res := v_res || 'outro_plano=' || sqlerrm || ';';
      end;
      perform pg_temp.bl_aplicar(v_p, 'RECEIVED');
      begin
        perform public.billing_prepare_checkout(v_b, 'premium', 'sandbox');
        v_res := v_res || 'ja_pago=PASSOU;';
      exception when others then v_res := v_res || 'ja_pago=' || sqlerrm || ';';
      end;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B11 regras do checkout',
      'cliente=NOT_A_SUPPLIER;repetido=reuse;outro_plano=PENDING_CHARGE_EXISTS;ja_pago=ALREADY_ON_PAID_PLAN;', v_res);

    -- B12. O cliente (role authenticated) não alcança nada disto.
    begin
      update public.billing_config set accepted_environment = 'sandbox';
      v_a := pg_temp.bl_conta('fornecedor');
      perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      v_res := '';
      begin
        perform public.billing_apply_gateway_payment('sandbox', 'x', 'RECEIVED', 99, 'c', 'r');
        v_res := 'apply=PASSOU;';
      exception when others then v_res := 'apply=' || sqlstate || ';';
      end;
      begin
        perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := v_res || 'prepare=PASSOU;';
      exception when others then v_res := v_res || 'prepare=' || sqlstate || ';';
      end;
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_res := v_res || 'config=PASSOU;';
      exception when others then v_res := v_res || 'config=' || sqlstate || ';';
      end;
      begin
        perform public.subscribe_to_plan('premium');
        v_res := v_res || 'subscribe_premium=PASSOU;';
      exception when others then v_res := v_res || 'subscribe_premium=' || sqlerrm || ';';
      end;
      perform public.subscribe_to_plan('basico');
      v_res := v_res || 'subscribe_basico=' || coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum') || ';';
      perform set_config('role', v_me, true);
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    perform pg_temp.bl_registrar('B12 cliente não alcança o motor; Básico continua',
      'apply=42501;prepare=42501;config=42501;subscribe_premium=PAYMENT_REQUIRED;subscribe_basico=basico;', v_res);

    -- ---------------- §233: pendentes vencidas, concorrência, análise manual
    declare
      v_j jsonb;
      v_j2 jsonb;
    begin
      -- B13. Pendente DENTRO da validade: reaproveita a mesma fatura.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        v_j := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        raise exception 'FIM:%', format('%s/mesma=%s/fatura=%s/vence_ate_vespera=%s', v_j ->> 'action',
          (v_j ->> 'payment_id' = v_p.id::text)::text, (v_j ->> 'invoice_url' is not null)::text,
          (v_p.due_date < (v_p.covers_until at time zone 'America/Sao_Paulo')::date)::text);
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B13 pendente válida reaproveita', 'reuse/mesma=true/fatura=true/vence_ate_vespera=true', v_res);

      -- B14. VENCIDA: não cria outra às cegas (check_stale); depois que o
      --      Asaas confirma a remoção, a antiga fica (auditoria) e nasce a nova.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        update public.payments set due_date = current_date - 2 where id = v_p.id;
        v_j := public.billing_prepare_checkout(v_a, 'profissional', 'sandbox');   -- até outro plano
        v_res := (v_j ->> 'action') || ',' || pg_temp.bl_aplicar(v_p, 'OVERDUE', p_deleted => true);
        v_j2 := public.billing_prepare_checkout(v_a, 'profissional', 'sandbox');
        select * into v_q from public.payments where id = v_p.id;
        raise exception 'FIM:%', v_res || format('/nova=%s,%s/antiga=%s,%s/pendentes=%s', v_j2 ->> 'action',
          (v_j2 ->> 'payment_id' <> v_p.id::text)::text, v_q.status, v_q.closed_reason,
          (select count(*) from public.payments where created_by = v_a and status = 'pending'));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B14 vencida: confere antes, preserva a antiga, cria a nova',
        'check_stale,voided/nova=create,true/antiga=refused,deleted_at_gateway/pendentes=1', v_res);

      -- B15. Cancelada no Asaas (removida) sem passar pelo checkout: o webhook
      --      anula; a próxima cobrança fica liberada.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        v_res := pg_temp.bl_aplicar(v_p, 'PENDING', p_deleted => true);
        v_j := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        raise exception 'FIM:%', v_res || '/' || (v_j ->> 'action') || format('/plano=%s',
          coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B15 cancelada no Asaas libera nova', 'voided/create/plano=nenhum', v_res);

      -- B16. PAGA durante a tentativa de substituição: o Asaas diz RECEIVED
      --      na re-consulta -> ativa, nenhuma cobrança nova; e se a anulação
      --      chegou a acontecer antes, o pagamento atrasado não duplica.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        update public.payments set due_date = current_date - 1 where id = v_p.id;
        v_res := (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action') || ','
              || pg_temp.bl_aplicar(v_p, 'RECEIVED');
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := v_res || ',nova=PASSOU';
        exception when others then v_res := v_res || ',nova=' || sqlerrm;
        end;
        raise exception 'FIM:%', v_res || format('/plano=%s/cobrancas=%s', public.fornecedor_current_plan_id(v_a),
          (select count(*) from public.payments where created_by = v_a));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B16 paga durante a substituição: ativa, sem cobrança nova',
        'check_stale,activated,nova=ALREADY_ON_PAID_PLAN/plano=premium/cobrancas=1', v_res);

      -- B17. Anulada e PAGA depois (corrida), com a nova também paga: um
      --      benefício só, as duas sinalizadas para análise.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        perform pg_temp.bl_aplicar(v_p, 'PENDING', p_deleted => true);
        v_q := pg_temp.bl_cobranca(v_a, 'premium');
        v_res := pg_temp.bl_aplicar(v_q, 'RECEIVED') || ',' || pg_temp.bl_aplicar(v_p, 'RECEIVED');
        raise exception 'FIM:%', v_res || format('/premium=%s/revisoes=%s',
          (select count(*) from public.subscriptions where created_by = v_a and plan_id = 'premium'),
          (select string_agg(reason, ',' order by reason) from public.billing_reviews where created_by = v_a));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B17 paga depois de anulada: um benefício, análise manual',
        'activated,approved_unapplied:PAID_PLAN_ALREADY_ACTIVE/premium=1/revisoes=PAID_AFTER_VOID,PAYMENT_UNAPPLIED_PAID_PLAN_ALREADY_ACTIVE',
        v_res);

      -- B18. Dois checkouts ao mesmo tempo: o 2º espera (reserva); reserva
      --      vencida é retomada pela MESMA linha; nunca duas pendentes.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_j := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_j2 := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := (v_j ->> 'action') || ',' || (v_j2 ->> 'action');
        update public.payments set gateway_claim_until = now() - interval '1 second' where id = (v_j ->> 'payment_id')::uuid;
        v_j2 := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        v_res := v_res || ',' || (v_j2 ->> 'action') || ',mesma=' || ((v_j2 ->> 'payment_id') = (v_j ->> 'payment_id'))::text;
        begin
          insert into public.payments (created_by, plan_id, billing_cycle, amount_cents, status, gateway, environment)
          values (v_a, 'premium', current_date, 9900, 'pending', 'asaas', 'sandbox');
          v_res := v_res || ',2a_pendente=PASSOU';
        exception when others then v_res := v_res || ',2a_pendente=' || sqlstate;
        end;
        raise exception 'FIM:%', v_res;
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B18 concorrência no checkout', 'create,wait,create,mesma=true,2a_pendente=23505', v_res);

      -- B19. Pendente que nunca chegou ao Asaas: só anula sem reserva ativa.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_j := public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
        begin
          perform public.billing_void_unattached((v_j ->> 'payment_id')::uuid);
          v_res := 'com_reserva=PASSOU';
        exception when others then v_res := 'com_reserva=' || sqlerrm;
        end;
        update public.payments set gateway_claim_until = now() - interval '1 second', due_date = current_date - 1
        where id = (v_j ->> 'payment_id')::uuid;
        v_res := v_res || ',' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
        v_res := v_res || ',' || public.billing_void_unattached((v_j ->> 'payment_id')::uuid);
        v_res := v_res || format(',motivo=%s', (select closed_reason from public.payments where id = (v_j ->> 'payment_id')::uuid));
        raise exception 'FIM:%', v_res || ',nova=' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B19 pendente sem cobrança no Asaas',
        'com_reserva=CLAIM_ACTIVE,check_stale,voided,motivo=unattached_void,nova=create', v_res);

      -- B20. Análise manual: cobrança órfã (referência nossa, id desconhecido),
      --      valor divergente e pagamento atrasado; e a reconciliação acha
      --      evento parado e pendente sem notícia.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        perform public.billing_apply_gateway_payment('sandbox', 'pay_orfa', 'RECEIVED', 99, v_p.gateway_customer_id, v_p.id::text);
        perform pg_temp.bl_aplicar(v_p, 'RECEIVED', p_value => 1);
        perform pg_temp.bl_aplicar(v_p, 'RECEIVED', p_value => 1);           -- repetido: 1 linha só
        insert into public.webhook_events (provider, event_id, event_type, payload, status, received_at)
        values ('asaas', 'evt_parado_' || v_p.id, 'PAYMENT_RECEIVED',
                jsonb_build_object('payment', jsonb_build_object('id', v_p.gateway_payment_id)), 'failed', now() - interval '1 hour');
        update public.payments set updated_at = now() - interval '1 hour' where id = v_p.id;
        raise exception 'FIM:%', format('revisoes=%s/candidatos=%s',
          (select string_agg(reason, ',' order by reason) from public.billing_reviews where payment_id = v_p.id),
          (select string_agg(kind, ',' order by kind) from public.billing_reconcile_candidates(500)
           where gateway_payment_id = v_p.gateway_payment_id));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B20 análise manual e reconciliação',
        'revisoes=AMOUNT_MISMATCH,ORPHAN_GATEWAY_CHARGE/candidatos=event,payment', v_res);

      -- ------------- §234: bloqueio por análise, cobranças de fora, execuções
      -- B21. Pago fora do período (em análise) BLOQUEIA novo checkout; a
      --      resolução administrativa libera; o plano nunca foi ativado.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        update public.payments set covers_until = now() - interval '1 day', due_date = current_date - 5 where id = v_p.id;
        v_res := pg_temp.bl_aplicar(v_p, 'RECEIVED');
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := v_res || ',checkout=PASSOU';
        exception when others then v_res := v_res || ',checkout=' || sqlerrm;
        end;
        begin
          perform public.billing_review_resolve((select id from public.billing_reviews where created_by = v_a limit 1), ' ');
          v_res := v_res || ',sem_texto=PASSOU';
        exception when others then v_res := v_res || ',sem_texto=' || sqlerrm;
        end;
        perform public.billing_review_resolve(r.id, 'reembolsado manualmente no painel do Asaas')
        from public.billing_reviews r where r.created_by = v_a and r.resolved_at is null;
        v_res := v_res || ',depois=' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
        raise exception 'FIM:%', v_res || format('/plano=%s', coalesce(public.fornecedor_current_plan_id(v_a), 'nenhum'));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B21 pagamento em análise bloqueia; resolução libera',
        'approved_unapplied:LATE_PAYMENT,checkout=PAYMENT_UNDER_REVIEW,sem_texto=RESOLUTION_REQUIRED,depois=create/plano=nenhum', v_res);

      -- B22. Estorno confirmado (REFUNDED) resolve a análise sozinho -> libera.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'profissional');
        update public.payments set covers_until = now() - interval '1 day', due_date = current_date - 5 where id = v_p.id;
        perform pg_temp.bl_aplicar(v_p, 'RECEIVED');
        v_res := pg_temp.bl_aplicar(v_p, 'REFUND_REQUESTED');
        v_res := v_res || format(',abertas=%s', (select count(*) from public.billing_reviews where created_by = v_a and resolved_at is null));
        v_res := v_res || ',' || pg_temp.bl_aplicar(v_p, 'REFUNDED');
        v_res := v_res || format(',abertas=%s', (select count(*) from public.billing_reviews where created_by = v_a and resolved_at is null));
        raise exception 'FIM:%', v_res || ',checkout=' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B22 estorno confirmado resolve sozinho',
        'reversed,abertas=1,already_reversed,abertas=0,checkout=create', v_res);

      -- B23. Cobrança EXTERNA: recusada sem análise. Cobrança desconhecida de
      --      um CLIENTE nosso: ambígua -> análise ligada à conta (bloqueia).
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        v_res := coalesce(public.billing_apply_gateway_payment('sandbox', 'pay_de_fora', 'RECEIVED', 10, 'cus_de_outra_loja', 'pedido-77') ->> 'reason', '?');
        v_res := v_res || format(',analises=%s', (select count(*) from public.billing_reviews where gateway_payment_id = 'pay_de_fora'));
        v_res := v_res || ',' || coalesce(public.billing_apply_gateway_payment('sandbox', 'pay_estranha', 'RECEIVED', 10, v_p.gateway_customer_id, null) ->> 'reason', '?');
        v_res := v_res || format(',analise=%s', (select reason from public.billing_reviews where gateway_payment_id = 'pay_estranha' and created_by = v_a));
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := v_res || ',checkout=PASSOU';
        exception when others then v_res := v_res || ',checkout=' || sqlerrm;
        end;
        raise exception 'FIM:%', v_res;
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B23 externa ignorada; ambígua vai para análise',
        'EXTERNAL_CHARGE,analises=0,UNKNOWN_CHARGE,analise=UNKNOWN_CHARGE_NEXAR_CUSTOMER,checkout=PAYMENT_UNDER_REVIEW', v_res);

      -- B24. Estado desconhecido (404) bloqueia; a reconsulta que acha a
      --      cobrança em aberto resolve sozinha e libera (sem bloqueio eterno).
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        perform public.billing_review_add('CHARGE_STATE_UNKNOWN', v_p.id, v_p.gateway_payment_id, null, '{"status":404}');
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := 'checkout=PASSOU';
        exception when others then v_res := 'checkout=' || sqlerrm;
        end;
        v_res := v_res || format(',candidato=%s', (select count(*) from public.billing_reconcile_candidates(500) where gateway_payment_id = v_p.gateway_payment_id));
        v_res := v_res || ',' || pg_temp.bl_aplicar(v_p, 'PENDING');
        raise exception 'FIM:%', v_res || ',depois=' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B24 estado desconhecido: bloqueia, reconsulta libera',
        'checkout=PAYMENT_UNDER_REVIEW,candidato=1,pending,depois=reuse', v_res);

      -- B25. Reconciliação: uma execução por vez; a que morreu no meio é
      --      abortada depois do lease.
      begin
        v_j := to_jsonb(public.billing_reconcile_begin('teste', 600));
        v_res := 'primeira=' || (v_j is not null and v_j <> 'null'::jsonb)::text;
        v_res := v_res || ',segunda=' || coalesce(public.billing_reconcile_begin('teste', 600)::text, 'null');
        update public.billing_reconcile_runs set started_at = now() - interval '2 hours' where id = (v_j #>> '{}')::uuid;
        v_res := v_res || ',depois_do_lease=' || (public.billing_reconcile_begin('teste', 600) is not null)::text;
        raise exception 'FIM:%', v_res || format(',antiga=%s', (select status from public.billing_reconcile_runs where id = (v_j #>> '{}')::uuid));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B25 reconciliação: uma por vez, lease',
        'primeira=true,segunda=null,depois_do_lease=true,antiga=aborted', v_res);

      -- B26. Falha ao ligar (resposta perdida, mas a ligação gravou):
      --      bloqueia; a reconsulta que acha a cobrança pelo id resolve
      --      sozinha e a fatura volta a ser reaproveitada (sem bloqueio eterno).
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        perform public.billing_review_add('ATTACH_FAILED', v_p.id, v_p.gateway_payment_id, null, '{"code":"UNKNOWN"}');
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := 'checkout=PASSOU';
        exception when others then v_res := 'checkout=' || sqlerrm;
        end;
        v_res := v_res || format(',candidato=%s', (select count(*) from public.billing_reconcile_candidates(500)
                                                    where gateway_payment_id = v_p.gateway_payment_id));
        v_res := v_res || ',' || pg_temp.bl_aplicar(v_p, 'PENDING');
        raise exception 'FIM:%', v_res || ',depois=' || (public.billing_prepare_checkout(v_a, 'premium', 'sandbox') ->> 'action');
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B26 falha de ligação: reconsulta libera',
        'checkout=PAYMENT_UNDER_REVIEW,candidato=1,pending,depois=reuse', v_res);

      -- B27. Anulada e RESTAURADA no painel do Asaas (volta "em aberto"):
      --      análise que bloqueia; a linha local não reabre.
      begin
        update public.billing_config set accepted_environment = 'sandbox';
        v_a := pg_temp.bl_conta('fornecedor');
        v_p := pg_temp.bl_cobranca(v_a, 'premium');
        v_res := pg_temp.bl_aplicar(v_p, 'PENDING', p_deleted => true) || ','
              || pg_temp.bl_aplicar(v_p, 'PENDING');
        begin
          perform public.billing_prepare_checkout(v_a, 'premium', 'sandbox');
          v_res := v_res || ',checkout=PASSOU';
        exception when others then v_res := v_res || ',checkout=' || sqlerrm;
        end;
        raise exception 'FIM:%', v_res || format('/status=%s/analise=%s',
          (select status from public.payments where id = v_p.id),
          (select reason from public.billing_reviews where payment_id = v_p.id and resolved_at is null));
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      perform pg_temp.bl_registrar('B27 cobrança restaurada no Asaas bloqueia',
        'voided,ignored:RESTORED_AFTER_VOID,checkout=PAYMENT_UNDER_REVIEW/status=refused/analise=RESTORED_AFTER_VOID', v_res);
    end;
  end;

  -- Permissões, depois.
  select string_agg(p.oid::regprocedure::text, ', ') into v_list
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and (p.proname like 'billing\_%' or p.proname in ('guard_paid_subscription', 'plan_price_cents'))
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  insert into _bl_testes values ('P1 nenhuma função de cobrança executável pelo cliente', '', coalesce(v_list, ''), coalesce(v_list, '') = '');

  select string_agg(format('%s:%s:%s', r, t, priv), ' ') into v_list
  from unnest(array['subscriptions', 'payments', 'payment_attempts', 'webhook_events', 'subscription_events',
                    'billing_config', 'billing_customers', 'billing_reviews', 'billing_reconcile_runs']) t
  cross join unnest(array['anon', 'authenticated']) r
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
  where has_table_privilege(r, 'public.' || t, priv)
    -- SELECT só importa nas tabelas novas (as antigas têm RLS de dono).
    and (priv <> 'SELECT' or t in ('billing_config', 'billing_customers', 'billing_reviews', 'billing_reconcile_runs'));
  insert into _bl_testes values ('P2 cliente sem escrita (e sem ler config/clientes)', '', coalesce(v_list, ''), coalesce(v_list, '') = '');

  insert into _bl_testes values ('P3 gatilho ligado', 'O',
    coalesce((select tgenabled::text from pg_trigger where tgname = 'trg_guard_paid_subscription'
              and tgrelid = 'public.subscriptions'::regclass), '-'),
    coalesce((select tgenabled::text from pg_trigger where tgname = 'trg_guard_paid_subscription'
              and tgrelid = 'public.subscriptions'::regclass), '-') = 'O');

  insert into _bl_testes values ('P4 subscribe_to_plan continua com a guarda C1', 'true',
    (position('PAYMENT_REQUIRED' in (select prosrc from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure)) > 0)::text,
    position('PAYMENT_REQUIRED' in (select prosrc from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure)) > 0);


  -- ------------------------------------------------------------------------
  -- 11) PÓS-VERIFICAÇÃO
  -- ------------------------------------------------------------------------
  perform pg_temp.bl_fotografar('depois');

  select string_agg(format('%s (antes %s/%s, depois %s/%s)', a.tabela, a.linhas, left(a.hash, 8),
                           coalesce(d.linhas::text, '-'), left(coalesce(d.hash, '-'), 8)), '; ')
    into v_list
  from _bl_foto a
  left join _bl_foto d on d.tabela = a.tabela and d.momento = 'depois'
  where a.momento = 'antes'
    and (d.tabela is null or (a.linhas, a.hash) is distinct from (d.linhas, d.hash));
  if v_list is not null then
    raise exception 'ABORTADO: dados existentes mudaram: %', v_list;
  end if;

  select string_agg(format('%s => esperado [%s] obtido [%s]', teste, esperado, obtido), E'\n') into v_list
  from _bl_testes where ok is not true;
  if v_list is not null then
    raise exception E'ABORTADO: teste(s) falharam -- nada foi aplicado:\n%', v_list;
  end if;

  perform set_config('nexar.bl_resultado',
    (select format('%s/%s testes ok', count(*) filter (where ok), count(*)) from _bl_testes), false);
end
$mig$;

notify pgrst, 'reload schema';

select 1 as ordem, 'testes embutidos' as item,
       coalesce(current_setting('nexar.bl_resultado', true), 'todos ok (DO terminou sem erro)') as valor
union all
select 2, 'ambiente aceito (NULL = cobrança desligada)',
       coalesce((select accepted_environment from public.billing_config where id), 'NULL')
union all
select 3, 'gatilho trg_guard_paid_subscription',
       coalesce((select case tgenabled when 'O' then 'ligado' else 'DESLIGADO' end from pg_trigger
                 where tgname = 'trg_guard_paid_subscription'), 'AUSENTE')
union all
select 4, 'funções de cobrança executáveis por anon/authenticated',
       coalesce((select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname like 'billing\_%'
                   and (has_function_privilege('anon', p.oid, 'execute')
                        or has_function_privilege('authenticated', p.oid, 'execute'))), 'nenhuma')
order by 1;
