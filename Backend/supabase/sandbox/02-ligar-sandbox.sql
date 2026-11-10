-- ==========================================================================
-- LIGA A COBRANÇA NO AMBIENTE SANDBOX -- SÓ NO PROJETO DE TESTE (§235)
--
-- Pré-requisitos: 01-marcar-projeto-teste.sql e asaas-billing.sql (30/30)
-- já rodados NESTE banco. Recusa rodar sem o marcador -- ou seja, no
-- projeto principal isto falha e nada muda. Nunca aceita 'production'.
-- Desligar de novo: update public.billing_config set accepted_environment = null;
-- ==========================================================================

do $liga$
begin
  if to_regnamespace('nexar_sandbox') is null or to_regclass('nexar_sandbox.marcador') is null then
    raise exception 'Sem o marcador do projeto de teste: este NÃO é o banco do Sandbox. Nada foi alterado.';
  end if;
  if (select project_ref from nexar_sandbox.marcador) = 'tzbawflkcivprblqzqjk' then
    raise exception 'Marcador aponta para o projeto PRINCIPAL. Nada foi alterado.';
  end if;
  if to_regclass('public.billing_config') is null then
    raise exception 'Rode asaas-billing.sql antes. Nada foi alterado.';
  end if;
  if position('PAYMENT_REQUIRED' in (select prosrc from pg_proc where oid = 'public.subscribe_to_plan(text)'::regprocedure)) = 0
     or not exists (select 1 from pg_trigger where tgname = 'trg_guard_paid_subscription' and tgenabled = 'O') then
    raise exception 'Proteção C1 incompleta (guarda ou gatilho ausente). Rode fix-paid-plan-activation.sql e asaas-billing.sql. Nada foi alterado.';
  end if;
  update public.billing_config set accepted_environment = 'sandbox', updated_at = now() where id;
end
$liga$;

select 'ambiente aceito' as item, accepted_environment as valor from public.billing_config
union all
select 'projeto de teste', project_ref from nexar_sandbox.marcador;
