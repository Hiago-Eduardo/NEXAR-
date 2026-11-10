-- NEXAR -- teste da fila de e-mails (Resumo.md §222). OPCIONAL.
--
-- Roda DEPOIS de transactional-emails.sql, no SQL Editor, inteiro de uma vez.
-- Tudo dentro de BEGIN ... ROLLBACK: nada fica gravado, nenhum e-mail sai
-- (não chama email_worker_tick, então não toca em pg_net nem na Edge
-- Function). Testa as duas regras que só existem no banco e que o Vitest não
-- alcança:
--   1. validade de 48 h (expire_stale_emails);
--   2. limite por usuário/hora contando o próprio lote (email_outbox_claim).
-- Sucesso = NOTICE "OK"; qualquer falha = EXCEPTION (e o rollback acontece
-- do mesmo jeito).

begin;

do $teste$
declare
  v_user uuid;
  v_velho uuid;
  v_status text;
  v_vencidos int;
  v_pegos int;
begin
  -- Um usuário real qualquer, sem nada pendente na fila (para a contagem do
  -- limite não misturar com e-mail de verdade).
  select u.id into v_user
  from auth.users u
  where not exists (select 1 from public.email_outbox o where o.to_user_id = u.id and o.status in ('pending', 'sending', 'sent'))
  order by u.created_at
  limit 1;
  if v_user is null then
    raise exception 'Sem usuário livre para o teste';
  end if;

  -- 1) Validade: um item de 49 h e um de agora.
  insert into public.email_outbox (dedupe_key, template, to_user_id, created_at)
  values ('teste-fila:velho', 'welcome', v_user, now() - interval '49 hours')
  returning id into v_velho;

  v_vencidos := public.expire_stale_emails();
  select status into v_status from public.email_outbox where id = v_velho;
  if v_status <> 'skipped' or v_vencidos < 1 then
    raise exception 'Validade: esperado skipped, veio % (vencidos=%)', v_status, v_vencidos;
  end if;

  -- 2) Limite: 12 pendentes para o mesmo usuário, limite 10, lote de 50.
  insert into public.email_outbox (dedupe_key, template, to_user_id, created_at)
  select 'teste-fila:n' || g, 'platform_notification', v_user, now() - make_interval(secs => 13 - g)
  from generate_series(1, 12) g;

  select count(*) into v_pegos
  from public.email_outbox_claim(50, 10) c
  where c.dedupe_key like 'teste-fila:%';
  if v_pegos <> 10 then
    raise exception 'Limite por usuário: esperado 10 no lote, veio %', v_pegos;
  end if;

  -- Os 10 viram 'sent' agora: um novo claim não pode pegar os 2 restantes.
  update public.email_outbox set status = 'sent', sent_at = now()
  where to_user_id = v_user and status = 'sending';
  select count(*) into v_pegos
  from public.email_outbox_claim(50, 10) c
  where c.dedupe_key like 'teste-fila:%';
  if v_pegos <> 0 then
    raise exception 'Limite por hora: esperado 0 depois de 10 enviados, veio %', v_pegos;
  end if;

  -- 3) Proteção contra duplicado que NÃO depende do provedor: o mesmo
  --    evento enfileirado duas vezes vira uma linha só, e uma linha já
  --    'sent' não volta para o claim (a chave da Brevo expira em minutos).
  perform public.enqueue_email('welcome', v_user, 'teste-fila:dup', '{}'::jsonb);
  perform public.enqueue_email('welcome', v_user, 'teste-fila:dup', '{}'::jsonb);
  select count(*) into v_pegos from public.email_outbox where dedupe_key = 'teste-fila:dup';
  if v_pegos <> 1 then
    raise exception 'Dedupe: esperado 1 linha para o mesmo evento, veio %', v_pegos;
  end if;
  update public.email_outbox set status = 'sent', sent_at = now() - interval '2 hours'
  where dedupe_key = 'teste-fila:dup';
  select count(*) into v_pegos
  from public.email_outbox_claim(50, 100) c
  where c.dedupe_key = 'teste-fila:dup';
  if v_pegos <> 0 then
    raise exception 'Dedupe: linha já enviada voltou para o claim';
  end if;

  raise notice 'OK: validade de 48 h, limite por usuário/hora e dedupe funcionando';
end
$teste$;

rollback;
