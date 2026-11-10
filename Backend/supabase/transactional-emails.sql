-- NEXAR -- e-mails transacionais com a Brevo (fila + Edge Function).
-- Ver CONTEXTO.MD/Resumo.md, seções 209, 221 e 222 (o provedor era o Resend
-- até a 222; nada no banco depende do provedor).
--
-- ADITIVO: tabela nova, funções novas, triggers novos. Nenhuma função,
-- policy ou trigger existente é alterado; nenhuma notificação in-app muda.
--
-- COMO FUNCIONA
--   1. Eventos confiáveis do banco gravam em public.email_outbox:
--        * notifications (insert) de tipos importantes -> reaproveita a
--          notificação que já existe (mesmo título/texto), sem criar outra;
--        * contact_requests (insert) -> "nova solicitação de orçamento" para
--          o DONO do anúncio (suppliers.created_by);
--        * auth.users: e-mail confirmado -> boas-vindas;
--        * diário: assinatura cancelada que vence em até 3 dias.
--      Pagamentos: só templates; nenhum trigger (o gateway não existe).
--   2. O destinatário é SEMPRE um usuário (to_user_id); o e-mail é lido de
--      auth.users na hora do envio. Ninguém escolhe destinatário/conteúdo
--      por requisição.
--   3. pg_cron chama email_worker_tick() a cada minuto; ele só chama a Edge
--      Function send-emails (pg_net) se houver algo na fila.
--   4. A Edge Function pega o lote (email_outbox_claim), envia pela Brevo e
--      grava o resultado (email_outbox_finish).
--
-- DUPLICIDADE: dedupe_key UNIQUE (o mesmo evento nunca entra duas vezes),
-- claim com FOR UPDATE SKIP LOCKED (dois workers não pegam a mesma linha) e
-- headers.idempotencyKey = id da linha (UUID) na Brevo, que só lembra a
-- chave por ~15-30 min; depois disso quem segura é a fila (dedupe_key UNIQUE
-- e linha 'sent' nunca volta a ser pega).
-- LIMITE: no máx. EMAIL_PER_USER_PER_HOUR por usuário por hora, contando o
-- próprio lote (o resto espera), lote de até 50.
-- VALIDADE: pending com mais de 48 h vira 'skipped' (expire_stale_emails).
-- FALHAS: qualquer erro ao enfileirar vira WARNING -- nunca desfaz a
-- notificação, o pedido de orçamento ou a confirmação de e-mail.
--
-- PRÉ-REQUISITOS
--   * payments-audit-notifications.sql (tabela notifications) -- já rodado.
--   * Extensões pg_cron (já ativa, plan-limits-cron.sql) e pg_net.
--   * Para o agendamento funcionar, DOIS segredos no Vault (não ficam neste
--     arquivo):
--       select vault.create_secret('https://<ref>.supabase.co/functions/v1/send-emails', 'nexar_email_worker_url');
--       select vault.create_secret('<mesmo valor de EMAIL_WORKER_SECRET>', 'nexar_email_worker_secret');
--     Sem eles o tick só registra um WARNING e não chama nada.
--
-- RODAR MANUALMENTE no SQL Editor do Supabase. Idempotente.

create extension if not exists pg_net with schema extensions;

begin;

-- ---------------------------------------------------------------------------
-- 1) Fila
-- ---------------------------------------------------------------------------

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  template text not null check (template in (
    'welcome', 'quote_request', 'platform_notification',
    'subscription_activated', 'subscription_expiring', 'subscription_expired',
    'subscription_suspended', 'subscription_cancelled',
    'payment_confirmed', 'payment_failed'
  )),
  to_user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_outbox_fila_idx
  on public.email_outbox (next_attempt_at) where status = 'pending';
create index if not exists email_outbox_usuario_enviados_idx
  on public.email_outbox (to_user_id, sent_at) where status = 'sent';

-- Só o backend (service_role / funções security definer) toca na fila.
alter table public.email_outbox enable row level security;
revoke all on public.email_outbox from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Enfileirar (interno)
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_email(
  p_template text, p_user uuid, p_dedupe_key text, p_data jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user is null or p_dedupe_key is null then
    return;
  end if;
  insert into public.email_outbox (template, to_user_id, dedupe_key, data)
  values (p_template, p_user, p_dedupe_key, coalesce(p_data, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;
exception when others then
  raise warning 'enqueue_email(%, %): %', p_template, p_dedupe_key, sqlerrm;
end;
$$;

revoke execute on function public.enqueue_email(text, uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Notificações importantes -> e-mail (mesmo texto da notificação in-app)
-- ---------------------------------------------------------------------------

create or replace function public.email_from_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template text := case new.type
    when 'subscription_started'     then 'subscription_activated'
    when 'subscription_cancelled'   then 'subscription_cancelled'
    when 'subscription_ended'       then 'subscription_expired'
    when 'subscription_suspended'   then 'subscription_suspended'
    when 'subscription_reactivated' then 'platform_notification'
    when 'plan_change_applied'      then 'platform_notification'
    when 'plan_limits_suspended'    then 'platform_notification'
    else null
  end;
begin
  if v_template is not null then
    perform public.enqueue_email(
      v_template, new.created_by, 'notification:' || new.id::text,
      jsonb_build_object('title', new.title, 'body', new.body, 'link', new.link, 'type', new.type)
    );
  end if;
  return null;
exception when others then
  raise warning 'email_from_notification: %', sqlerrm;
  return null;
end;
$$;

revoke execute on function public.email_from_notification() from public, anon, authenticated;

drop trigger if exists trg_email_from_notification on public.notifications;
create trigger trg_email_from_notification
after insert on public.notifications
for each row execute function public.email_from_notification();

-- ---------------------------------------------------------------------------
-- 4) Nova solicitação de orçamento -> dono do anúncio
-- ---------------------------------------------------------------------------

create or replace function public.email_from_contact_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dono uuid;
  v_anuncio text;
begin
  select s.created_by, s.business_name into v_dono, v_anuncio
  from public.suppliers s where s.id = new.supplier_id;

  -- Sem dono, ou a pessoa pedindo orçamento ao próprio anúncio: nada.
  if v_dono is null or v_dono = new.created_by then
    return null;
  end if;

  -- Só nome e um trecho da mensagem; e-mail/telefone de quem pediu ficam
  -- no painel (atrás do login), não no e-mail.
  perform public.enqueue_email(
    'quote_request', v_dono, 'contact_request:' || new.id::text,
    jsonb_build_object(
      'supplier_name', v_anuncio,
      'sender_name', left(coalesce(new.sender_name, ''), 80),
      'message_excerpt', left(coalesce(new.message, ''), 300)
    )
  );
  return null;
exception when others then
  raise warning 'email_from_contact_request: %', sqlerrm;
  return null;
end;
$$;

revoke execute on function public.email_from_contact_request() from public, anon, authenticated;

drop trigger if exists trg_email_from_contact_request on public.contact_requests;
create trigger trg_email_from_contact_request
after insert on public.contact_requests
for each row execute function public.email_from_contact_request();

-- ---------------------------------------------------------------------------
-- 5) Boas-vindas quando o e-mail é confirmado
--    (contas antigas já confirmadas não disparam: só a passagem null -> data)
-- ---------------------------------------------------------------------------

create or replace function public.email_welcome_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_nome text;
  v_tipo text;
begin
  if new.email_confirmed_at is null
     or (tg_op = 'UPDATE' and old.email_confirmed_at is not null) then
    return null;
  end if;

  select up.full_name, up.user_type into v_nome, v_tipo
  from public.user_profiles up where up.created_by = new.id limit 1;

  perform public.enqueue_email(
    'welcome', new.id, 'welcome:' || new.id::text,
    jsonb_build_object(
      'full_name', coalesce(v_nome, new.raw_user_meta_data ->> 'full_name', ''),
      'user_type', coalesce(v_tipo, new.raw_user_meta_data ->> 'user_type', 'cliente')
    )
  );
  return null;
exception when others then
  raise warning 'email_welcome_on_confirm: %', sqlerrm;
  return null;
end;
$$;

revoke execute on function public.email_welcome_on_confirm() from public, anon, authenticated;

drop trigger if exists nexar_email_welcome_on_confirm on auth.users;
create trigger nexar_email_welcome_on_confirm
after insert or update of email_confirmed_at on auth.users
for each row execute function public.email_welcome_on_confirm();

-- ---------------------------------------------------------------------------
-- 6) Vencimento: assinatura cancelada que termina em até 3 dias (diário)
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_subscription_expiring_emails()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := 0;
  r record;
begin
  for r in
    select s.id, s.created_by, s.expires_at
    from public.subscriptions s
    where s.status = 'cancelled'
      and s.expires_at > now()
      and s.expires_at <= now() + interval '3 days'
  loop
    perform public.enqueue_email(
      'subscription_expiring', r.created_by,
      'subscription_expiring:' || r.id::text || ':' || to_char(r.expires_at at time zone 'America/Sao_Paulo', 'YYYY-MM-DD'),
      jsonb_build_object('expires_on', to_char(r.expires_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'))
    );
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke execute on function public.enqueue_subscription_expiring_emails() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Worker: pegar e finalizar (só service_role, usado pela Edge Function)
-- ---------------------------------------------------------------------------

create or replace function public.email_outbox_claim(p_limit int default 20, p_per_user_hour int default 10)
returns table (id uuid, template text, data jsonb, dedupe_key text, to_email text, attempts int)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  -- Linha presa em 'sending' há 10 min (função morreu no meio): volta.
  update public.email_outbox o
  set status = 'pending', updated_at = now()
  where o.status = 'sending' and o.updated_at < now() - interval '10 minutes';

  -- Limite por usuário/hora contando TAMBÉM os itens deste lote: a posição
  -- do item na fila do usuário (rn) soma com o que já saiu na última hora.
  -- Antes só contava os enviados, e um lote podia levar 20 e-mails para a
  -- mesma pessoa (Resumo.md §218, achado 2). A janela fica num CTE à parte
  -- porque o Postgres não aceita FOR UPDATE junto de window function.
  return query
  with fila as (
    select o.id,
           row_number() over (partition by o.to_user_id order by o.created_at, o.id) as rn,
           (select count(*) from public.email_outbox e
            where e.to_user_id = o.to_user_id and e.status = 'sent'
              and e.sent_at > now() - interval '1 hour') as enviados_hora
    from public.email_outbox o
    where o.status = 'pending'
      and o.next_attempt_at <= now()
  ),
  candidatos as (
    select o.id
    from public.email_outbox o
    join fila f on f.id = o.id
    where f.enviados_hora + f.rn <= greatest(p_per_user_hour, 1)
    order by o.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 50))
    for update of o skip locked
  ),
  marcados as (
    update public.email_outbox o
    set status = 'sending', attempts = o.attempts + 1, updated_at = now()
    from candidatos c
    where o.id = c.id
    returning o.id, o.template, o.data, o.dedupe_key, o.to_user_id, o.attempts
  )
  select m.id, m.template, m.data, m.dedupe_key, u.email::text, m.attempts
  from marcados m
  left join auth.users u on u.id = m.to_user_id;
end;
$$;

create or replace function public.email_outbox_finish(
  p_id uuid,
  p_status text,
  p_error text default null,
  p_provider_id text default null,
  p_retry_after_seconds int default null,
  p_count_attempt boolean default true
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('sent', 'failed', 'retry', 'skipped') then
    raise exception 'email_outbox_finish: status inválido %', p_status;
  end if;

  update public.email_outbox
  set status = case when p_status = 'retry' then 'pending' else p_status end,
      attempts = case when p_count_attempt then attempts else greatest(attempts - 1, 0) end,
      last_error = left(p_error, 500),
      provider_message_id = coalesce(p_provider_id, provider_message_id),
      sent_at = case when p_status = 'sent' then now() else sent_at end,
      next_attempt_at = case
        when p_status = 'retry' then now() + make_interval(secs => greatest(coalesce(p_retry_after_seconds, 60), 1))
        else next_attempt_at end,
      updated_at = now()
  where id = p_id and status = 'sending';
end;
$$;

revoke execute on function public.email_outbox_claim(int, int) from public, anon, authenticated;
revoke execute on function public.email_outbox_finish(uuid, text, text, text, int, boolean) from public, anon, authenticated;
grant execute on function public.email_outbox_claim(int, int) to service_role;
grant execute on function public.email_outbox_finish(uuid, text, text, text, int, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 8) Agendamento
-- ---------------------------------------------------------------------------

-- Validade: e-mail parado na fila há mais de 48 h não sai mais. Sem isto,
-- uma fila acumulada (modo disabled, função fora do ar) saía inteira ao
-- religar, com avisos velhos (Resumo.md §218, achado 1). Roda no TICK e não
-- no claim porque no modo disabled a função nem chama o claim -- e, com a
-- fila esvaziando sozinha, o tick para de chamar a função a cada minuto
-- (achado 3). 48 h passa folgado da cadeia de novas tentativas (~2,6 h).
-- Função à parte para poder ser testada sem chamar a rede (bloco no fim).
create or replace function public.expire_stale_emails()
returns int
language sql
security definer
set search_path = public
as $$
  with vencidos as (
    update public.email_outbox
    set status = 'skipped', last_error = 'Vencido: mais de 48 h na fila', updated_at = now()
    where status = 'pending' and created_at < now() - interval '48 hours'
    returning 1
  )
  select count(*)::int from vencidos;
$$;

revoke execute on function public.expire_stale_emails() from public, anon, authenticated;

create or replace function public.email_worker_tick()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url text;
  v_secret text;
begin
  perform public.expire_stale_emails();

  if not exists (
    select 1 from public.email_outbox
    where (status = 'pending' and next_attempt_at <= now())
       or (status = 'sending' and updated_at < now() - interval '10 minutes')
  ) then
    return;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'nexar_email_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nexar_email_worker_secret';
  if v_url is null or v_secret is null then
    raise warning 'email_worker_tick: crie os segredos nexar_email_worker_url e nexar_email_worker_secret no Vault';
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-email-worker-secret', v_secret),
    timeout_milliseconds := 30000
  );
end;
$$;

revoke execute on function public.email_worker_tick() from public, anon, authenticated;

-- Limpeza: enviados/ignorados há mais de 90 dias, falhas há mais de 180.
create or replace function public.prune_email_outbox()
returns int
language sql
security definer
set search_path = public
as $$
  with apagados as (
    delete from public.email_outbox
    where (status in ('sent', 'skipped') and updated_at < now() - interval '90 days')
       or (status = 'failed' and updated_at < now() - interval '180 days')
    returning 1
  )
  select count(*)::int from apagados;
$$;

revoke execute on function public.prune_email_outbox() from public, anon, authenticated;

select cron.schedule('nexar-email-worker', '* * * * *', 'select public.email_worker_tick()');
-- 12:00 UTC = 09:00 em Brasília.
select cron.schedule('nexar-email-daily', '0 12 * * *',
  'select public.enqueue_subscription_expiring_emails(); select public.prune_email_outbox();');

commit;

-- ---------------------------------------------------------------------------
-- Conferência (leitura)
--   select status, template, count(*) from public.email_outbox group by 1, 2;
--   select jobname, schedule, active from cron.job where jobname like 'nexar-email%';
--   select id, template, status, attempts, last_error, created_at
--   from public.email_outbox order by created_at desc limit 20;
--
-- Desligar sem apagar nada:
--   select cron.unschedule('nexar-email-worker');
--   (ou EMAIL_SENDING_MODE=disabled nos secrets da função: a fila acumula
--    e nada sai.)
-- ---------------------------------------------------------------------------
