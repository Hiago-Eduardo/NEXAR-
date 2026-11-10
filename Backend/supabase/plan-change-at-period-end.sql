-- *** 2026-11-03 (C1, Resumo.md §231-232): o subscribe_to_plan deste arquivo
-- ganhou a guarda PAYMENT_REQUIRED (só o Básico). A versão VIVA é a de
-- fix-paid-plan-activation.sql; se re-rodar este arquivo, rode depois
-- plan-limits-central.sql e fix-paid-plan-activation.sql (nessa ordem).
-- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
-- recusa assinatura paga sem pagamento aprovado mesmo assim. ***
-- ==========================================================================
-- TROCA DE PLANO SEMPRE NO FIM DO CICLO (quando já se paga)
--
-- SUBSTITUI a versão de `subscribe_to_plan` que está em
-- supabase/subscription-plan-change.sql. Aquele arquivo continua valendo para
-- todo o resto (status 'scheduled', índices, sync_my_subscription,
-- cancel_scheduled_plan_change, my_current_subscription...) -- só esta função
-- muda.
--
-- >>> SE ALGUÉM RE-RODAR subscription-plan-change.sql DEPOIS DESTE ARQUIVO,
-- >>> A REGRA ANTIGA VOLTA EM SILÊNCIO. Rode este por último. <<<
--
-- O QUE MUDA (decisão do usuário, seção 109):
-- Antes a regra era assimétrica -- UPGRADE valia na hora (cobrando na hora) e
-- DOWNGRADE ficava para o fim do ciclo. Quem subia de Profissional para
-- Premium perdia os dias que já tinha pago e era cobrado de novo no mesmo dia.
--
-- Agora o que decide NÃO é a direção da troca, é se o fornecedor JÁ PAGA:
--
--   sem plano      -> qualquer    IMEDIATO   (cobra agora)
--   Básico         -> pago        IMEDIATO   (cobra agora)
--   pago           -> pago        FIM DO CICLO (cobra no fim)
--   pago           -> Básico      FIM DO CICLO (sem cobrança)
--
-- POR QUE O BÁSICO É EXCEÇÃO, e não um esquecimento: o Básico é grátis e não
-- vence (expires_at = 'infinity'). Se a saída dele também esperasse "o plano
-- acabar", a espera seria infinita e NINGUÉM conseguiria assinar nada. A
-- exceção é o que torna a regra possível, não um furo nela.
--
-- Ninguém perde tempo pago: o plano vigente vale até o último dia, e o novo
-- começa exatamente quando o atual termina.
--
-- RODADO NO BANCO em 2026-09-19 e a regra confirmada lendo o corpo da função
-- em pg_proc (seção 110): 'Saindo do BÁSICO' presente, 'UPGRADE: vale agora'
-- ausente. Ou seja, esta versão substituiu mesmo a antiga.
--
-- Estruturalmente re-executável: é `create or replace` puro mais revoke/grant,
-- sem DDL de tabela, policy ou trigger -- não existe aqui o tipo de instrução
-- que abortou o script da seção 94. Mas, pela regra daquela seção, só passa a
-- valer como VERIFICADO depois de uma segunda execução sem erro.
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

  -- ---------- Saindo do BÁSICO: vale agora ----------
  -- Único caso imediato com plano vigente. O teste é pelo plano em si, não
  -- por plan_rank(): é o "ser grátis e não vencer" que obriga a ser imediato,
  -- e amarrar no rank faria a regra quebrar sozinha se a hierarquia mudasse.
  if v_current.plan_id = 'basico' then
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

  -- ---------- Já paga: a troca vale no FIM DO CICLO ----------
  -- Vale para os dois sentidos (subir e descer). O plano atual segue intacto
  -- até expires_at -- nada é encerrado aqui, porque o fornecedor pagou por
  -- esses dias.
  --
  -- Guarda-costas que continua valendo: um plano 'infinity' não tem fim de
  -- ciclo de onde partir. Depois do ramo do Básico acima isso não deveria
  -- acontecer, mas se um plano pago virar infinito um dia, falha explícito em
  -- vez de criar um agendamento que nunca entra.
  if v_current.expires_at = 'infinity'::timestamptz then
    raise exception 'CANNOT_SCHEDULE_FROM_UNLIMITED_PLAN';
  end if;

  v_starts := v_current.expires_at;

  -- Só pode haver um agendamento: o novo substitui o anterior. É isso que
  -- deixa o fornecedor trocar de ideia quantas vezes quiser antes da virada.
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

revoke execute on function public.subscribe_to_plan(text) from public, anon;
grant execute on function public.subscribe_to_plan(text) to authenticated;

notify pgrst, 'reload schema';
