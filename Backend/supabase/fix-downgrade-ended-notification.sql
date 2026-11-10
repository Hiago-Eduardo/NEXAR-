-- ==========================================================================
-- CORREÇÃO: "Assinatura encerrada" falso na virada de um downgrade
--
-- Achado na Etapa B (Resumo.md seção 196): na virada Premium -> Básico a
-- conta recebia, junto de "Troca de plano aplicada", a notificação
-- "Assinatura encerrada -- Você está sem plano...". Falso: ela continua no
-- Básico.
--
-- CAUSA: advance_subscription_state faz a virada em dois updates --
-- (a) o plano que venceu vira 'expired', (b) o 'scheduled' cuja data chegou
-- vira 'active'. O trigger roda no (a), quando o sucessor ainda é
-- 'scheduled', e o único discriminador que existia (old.expires_at no
-- passado = venceu de verdade) não enxerga o sucessor. O upgrade não sofria
-- disso porque nele expires_at é forçado para now() (ramo plan_replaced).
--
-- CORREÇÃO: ao vencer de verdade, olhar se a conta tem SUCESSOR vigente:
--   * um 'scheduled' com started_at <= now() < expires_at (vai ser
--     promovido no passo (b) desta mesma transação), ou
--   * um 'active' com started_at <= now() < expires_at.
-- Com sucessor: evento 'plan_replaced' sem notificação (quem avisa é o
-- "Troca de plano aplicada" do sucessor), metadata.reason='scheduled_change'.
-- Sem sucessor: "Assinatura encerrada", como antes. Agendado que já nasceu
-- vencido (passo (c)) não conta como sucessor: a conta fica mesmo sem plano,
-- e o (c) avisa ao encerrá-lo.
--
-- SUBSTITUI log_subscription_event (de payments-audit-notifications.sql).
-- Re-rodar aquele arquivo depois deste DESFAZ a correção -- este vai por
-- último. O resto do corpo é idêntico.
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

drop table if exists _fden_relatorio;
drop table if exists _fden_testes;

begin;

create temp table _fden_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.subscriptions)       as subscriptions,
  (select count(*) from public.subscription_events) as subscription_events,
  (select count(*) from public.notifications)       as notifications,
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b) as hash_subscriptions,
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s) as hash_suppliers;

create or replace function public.log_subscription_event()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tipo text;
  v_titulo text;
  v_corpo text;
  v_notificar boolean := true;
  v_motivo text;
begin
  if TG_OP = 'INSERT' then
    if new.status = 'scheduled' then
      v_tipo   := 'plan_change_scheduled';
      v_titulo := 'Troca de plano confirmada';
      v_corpo  := 'A troca entra em vigor em ' || to_char(new.started_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';
    else
      v_tipo   := 'subscription_started';
      v_titulo := 'Plano ativado';
      v_corpo  := 'Seu plano está ativo. Próxima cobrança em '
                  || coalesce(to_char(new.next_charge_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'), 'nenhuma (plano gratuito)') || '.';
    end if;

  elsif TG_OP = 'UPDATE' then
    -- Só interessa mudança de STATUS. Um update que mexe em next_charge_at
    -- sem mudar status não é evento para o usuário.
    if old.status is not distinct from new.status then
      return null;
    end if;

    if new.status = 'cancelled' then
      v_tipo   := 'subscription_cancelled';
      v_titulo := 'Cancelamento agendado';
      v_corpo  := 'Você continua com os benefícios até '
                  || to_char(new.expires_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';

    elsif old.status = 'cancelled' and new.status = 'active' then
      v_tipo   := 'subscription_reactivated';
      v_titulo := 'Cancelamento desfeito';
      v_corpo  := 'Sua assinatura continua normalmente.';

    elsif old.status = 'scheduled' and new.status = 'active' then
      v_tipo   := 'plan_change_applied';
      v_titulo := 'Troca de plano aplicada';
      v_corpo  := 'Seu novo plano já está valendo.';

    elsif new.status = 'suspended' then
      v_tipo   := 'subscription_suspended';
      v_titulo := 'Plano suspenso';
      v_corpo  := 'Não conseguimos confirmar o pagamento. Seus anúncios ficam suspensos até a regularização -- nada foi apagado.';

    elsif new.status = 'expired' then
      -- DISCRIMINADOR 1, e sem ele o upgrade avisaria "assinatura
      -- encerrada" um instante antes de avisar "plano ativado".
      --   expirou de verdade  -> old.expires_at JÁ ESTAVA no passado
      --   encerrada no upgrade -> old.expires_at estava no FUTURO e
      --                           subscribe_to_plan a forçou para now()
      -- DISCRIMINADOR 2 (seção 197): venceu de verdade, mas um plano
      -- agendado entra no lugar na mesma virada (downgrade no dia 10). O
      -- sucessor ainda está 'scheduled' quando este trigger roda.
      if old.expires_at > now() then
        v_motivo := 'upgrade';
      elsif exists (
        select 1 from public.subscriptions s
        where s.created_by = new.created_by
          and s.id <> new.id
          and s.status in ('scheduled', 'active')
          and s.started_at <= now()
          and s.expires_at > now()
      ) then
        v_motivo := 'scheduled_change';
      end if;

      if v_motivo is null then
        v_tipo   := 'subscription_ended';
        v_titulo := 'Assinatura encerrada';
        v_corpo  := 'Você está sem plano. Seus anúncios e produtos ficam suspensos até você assinar de novo -- nada foi apagado.';
      else
        v_tipo      := 'plan_replaced';
        v_notificar := false;  -- quem avisa é o plano novo (insert ou promoção)
      end if;

    else
      v_tipo      := 'status_changed';
      v_notificar := false;
    end if;
  else
    return null;
  end if;

  -- AUDITORIA: sempre, inclusive para os eventos que não viram notificação.
  -- É a diferença entre o histórico técnico (completo) e o que a pessoa lê
  -- (só o que importa para ela) -- a spec §19 pede exatamente essa separação.
  insert into public.subscription_events (
    created_by, subscription_id, event_type, from_plan, to_plan,
    from_status, to_status, metadata
  ) values (
    new.created_by, new.id, v_tipo,
    case when TG_OP = 'UPDATE' then old.plan_id end, new.plan_id,
    case when TG_OP = 'UPDATE' then old.status end, new.status,
    jsonb_build_object(
      'expires_at', new.expires_at,
      'next_charge_at', new.next_charge_at,
      'op', TG_OP
    ) || case when v_motivo is not null then jsonb_build_object('reason', v_motivo) else '{}'::jsonb end
  );

  if v_notificar then
    insert into public.notifications (created_by, type, title, body, link, metadata)
    values (new.created_by, v_tipo, v_titulo, v_corpo, '/Dashboard',
            jsonb_build_object('subscription_id', new.id, 'plan_id', new.plan_id));
  end if;

  return null;
exception when others then
  -- NUNCA derrubar a operação do usuário por causa do log. Se a auditoria
  -- falhar, a assinatura tem que valer assim mesmo -- o inverso seria um
  -- fornecedor impedido de assinar porque uma tabela acessória quebrou.
  raise warning 'log_subscription_event falhou: %', sqlerrm;
  return null;
end;
$function$;

revoke execute on function public.log_subscription_event() from public, anon, authenticated;

insert into _fden_foto
select
  'depois',
  (select count(*) from public.subscriptions),
  (select count(*) from public.subscription_events),
  (select count(*) from public.notifications),
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b),
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s);

do $confere$
declare
  a _fden_foto;
  d _fden_foto;
begin
  select * into a from _fden_foto where momento = 'antes';
  select * into d from _fden_foto where momento = 'depois';
  if (a.subscriptions, a.subscription_events, a.notifications, a.hash_subscriptions, a.hash_suppliers)
     is distinct from
     (d.subscriptions, d.subscription_events, d.notifications, d.hash_subscriptions, d.hash_suppliers)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%', to_jsonb(a), to_jsonb(d);
  end if;
end
$confere$;

create temp table _fden_relatorio as select * from _fden_foto;

commit;


-- ==========================================================================
-- TESTES -- NADA FICA GRAVADO (cada sub-bloco termina em exceção)
--
-- Usam a conta de teste teste-limites@nexar.test (Etapa B): hoje ela tem 1
-- assinatura basico/active (infinity) e 1 premium/expired. Cada teste monta
-- o cenário nela, roda a virada de verdade (advance_subscription_state) e
-- lê as notificações criadas -- tudo desfeito no fim.
-- ==========================================================================

create temp table _fden_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_uid uuid;
  v_ids uuid[];
  v_res text;
begin
  select id into v_uid from auth.users where email = 'teste-limites@nexar.test';
  if v_uid is null then
    insert into _fden_testes values ('-', '-', 'conta de teste não encontrada: testes pulados', null);
    return;
  end if;
  select coalesce(array_agg(id), '{}') into v_ids from public.notifications where created_by = v_uid;

  -- 1) virada de DOWNGRADE: o atual vence e um agendado entra no lugar
  begin
    update public.subscriptions set expires_at = now() - interval '1 second'
    where created_by = v_uid and status = 'active';
    insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at, next_charge_at)
    -- Básico agendado: desde 2026-11-03 (C1) não existe agendamento pago
    -- sem pagamento -- o gatilho de asaas-billing.sql recusa. O que se testa
    -- aqui (sucessor na virada) não depende do plano.
    values (v_uid, 'basico', 'scheduled', now() - interval '1 second', 'infinity', null);
    perform public.advance_subscription_state(v_uid);
    select coalesce(string_agg(type, ',' order by type), '-') into v_res
    from public.notifications where created_by = v_uid and not (id = any(v_ids))
      and type in ('subscription_ended', 'plan_change_applied', 'plan_change_scheduled');
    v_res := v_res || ' | evento=' || coalesce((select event_type || '/' || (metadata->>'reason')
      from public.subscription_events where created_by = v_uid and to_status = 'expired'
      order by created_at desc limit 1), '-');
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _fden_testes values ('1. virada de downgrade: sem "encerrada"',
    'plan_change_applied,plan_change_scheduled | evento=plan_replaced/scheduled_change', v_res,
    v_res = 'plan_change_applied,plan_change_scheduled | evento=plan_replaced/scheduled_change');

  -- 2) vencimento DE VERDADE (sem sucessor): continua avisando
  begin
    update public.subscriptions set expires_at = now() - interval '1 second'
    where created_by = v_uid and status = 'active';
    perform public.advance_subscription_state(v_uid);
    select coalesce(string_agg(type, ',' order by type), '-') into v_res
    from public.notifications where created_by = v_uid and not (id = any(v_ids))
      and type in ('subscription_ended', 'plan_change_applied');
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _fden_testes values ('2. venceu sem sucessor: avisa "encerrada"', 'subscription_ended', v_res, v_res = 'subscription_ended');

  -- 3) agendado que já nasceu vencido não conta como sucessor: a conta
  --    fica sem plano e o aviso sai. (Sai duas vezes -- no (a) e no (c) --,
  --    caso raro que já era assim antes desta correção.)
  begin
    update public.subscriptions set expires_at = now() - interval '2 seconds'
    where created_by = v_uid and status = 'active';
    insert into public.subscriptions (created_by, plan_id, status, started_at, expires_at)
    values (v_uid, 'basico', 'scheduled', now() - interval '2 seconds', now() - interval '1 second');
    perform public.advance_subscription_state(v_uid);
    select coalesce(string_agg(type, ',' order by type), '-') into v_res
    from public.notifications where created_by = v_uid and not (id = any(v_ids))
      and type = 'subscription_ended';
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  insert into _fden_testes values ('3. agendado já vencido: conta sem plano avisa', 'subscription_ended', v_res,
    v_res like 'subscription_ended%');

  -- 4) upgrade pela RPC NÃO existe mais (C1, seção 231): subscribe_to_plan
  --    recusa plano pago e nada é notificado.
  begin
    update public.subscriptions set expires_at = now() + interval '5 days'
    where created_by = v_uid and status = 'active';
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    begin
      perform public.subscribe_to_plan('premium');
    exception when others then
      if sqlerrm <> 'PAYMENT_REQUIRED' then raise; end if;
    end;
    perform set_config('request.jwt.claims', '', true);
    select coalesce(string_agg(type, ',' order by type), '-') into v_res
    from public.notifications where created_by = v_uid and not (id = any(v_ids))
      and type in ('subscription_ended', 'subscription_started');
    raise exception 'FIM:%', v_res;
  exception when others then v_res := replace(sqlerrm, 'FIM:', '');
  end;
  perform set_config('request.jwt.claims', '', true);
  insert into _fden_testes values ('4. upgrade pago pela RPC: recusado, nada notificado', '-', v_res, v_res = '-');

  insert into _fden_testes values ('5. notificações da conta de teste intactas', array_length(v_ids, 1)::text,
    (select count(*) from public.notifications where created_by = v_uid)::text,
    (select count(*) from public.notifications where created_by = v_uid) = coalesce(array_length(v_ids, 1), 0));
end
$testes$;

select 'contagem ' || momento as teste,
       format('subscriptions=%s eventos=%s notificações=%s', subscriptions, subscription_events, notifications) as esperado,
       format('hash sub=%s sup=%s', left(hash_subscriptions, 8), left(hash_suppliers, 8)) as obtido,
       null::boolean as ok
from _fden_relatorio
union all
select teste, esperado, obtido, ok from _fden_testes
union all
select 'contagem agora (pós-testes)',
       format('subscriptions=%s eventos=%s notificações=%s',
              (select count(*) from public.subscriptions), (select count(*) from public.subscription_events),
              (select count(*) from public.notifications)),
       format('hash sub=%s sup=%s',
              left((select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b), 8),
              left((select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s), 8)),
       null;
