-- ==========================================================================
-- AGENDAMENTO DA RECONCILIAÇÃO ASAAS (Resumo.md §234). PREPARADO, NÃO RODADO.
--
-- Só para o projeto Supabase de TESTE (Sandbox), depois de asaas-billing.sql
-- e do deploy da Edge Function billing-reconcile. RECUSA rodar se a
-- cobrança estiver desligada neste banco (billing_config.accepted_environment
-- NULL) -- é o caso do banco real: não agende lá.
--
-- Antes, no Vault do projeto de teste (SQL Editor; valores nunca no repo):
--   select vault.create_secret('https://<ref-teste>.supabase.co/functions/v1/billing-reconcile',
--                              'nexar_billing_reconcile_url');
--   select vault.create_secret('<mesmo valor de BILLING_RECONCILE_SECRET>',
--                              'nexar_billing_reconcile_secret');
--
-- O que faz: cria billing_reconcile_tick() (pg_net -> Edge Function com o
-- segredo no header x-billing-reconcile-secret, lote 100) e agenda
-- 'nexar-billing-reconcile' a cada 15 min. Execuções concorrentes não se
-- somam: a Edge Function abre a execução em billing_reconcile_begin e uma
-- segunda sai como skipped. Desligar:
--   select cron.unschedule('nexar-billing-reconcile');
-- Um único bloco DO (lição do §231). RE-EXECUTÁVEL.
-- ==========================================================================

do $cron$
begin
  if to_regclass('public.billing_config') is null then
    raise exception 'PRECHECK: rode asaas-billing.sql antes. Nada foi alterado.';
  end if;
  if (select accepted_environment from public.billing_config where id) is null then
    raise exception 'PRECHECK: cobrança DESLIGADA neste banco (accepted_environment NULL). Este agendamento é só para o projeto de teste. Nada foi alterado.';
  end if;
  -- §235: só no banco marcado como projeto de teste (supabase/sandbox/01-...).
  if to_regclass('nexar_sandbox.marcador') is null then
    raise exception 'PRECHECK: sem o marcador nexar_sandbox.marcador -- este não é o projeto de teste. Nada foi alterado.';
  end if;
  if to_regnamespace('cron') is null or to_regnamespace('net') is null then
    raise exception 'PRECHECK: habilite as extensões pg_cron e pg_net. Nada foi alterado.';
  end if;

  create or replace function public.billing_reconcile_tick()
   returns void
   language plpgsql
   security definer
   set search_path to 'public', 'extensions', 'pg_temp'
  as $f$
  declare
    v_url text;
    v_secret text;
  begin
    -- Desligado aqui = não chama nada (ex.: alguém zerou o ambiente).
    if (select accepted_environment from public.billing_config where id) is null then
      return;
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'nexar_billing_reconcile_url';
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'nexar_billing_reconcile_secret';
    if v_url is null or v_secret is null or length(v_secret) < 32 then
      raise warning 'billing_reconcile_tick: crie nexar_billing_reconcile_url e nexar_billing_reconcile_secret (>= 32) no Vault';
      return;
    end if;
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('source', 'cron', 'limit', 100),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-reconcile-secret', v_secret),
      timeout_milliseconds := 55000
    );
  end;
  $f$;

  revoke all on function public.billing_reconcile_tick() from public, anon, authenticated;

  if exists (select 1 from cron.job where jobname = 'nexar-billing-reconcile') then
    perform cron.unschedule('nexar-billing-reconcile');
  end if;
  perform cron.schedule('nexar-billing-reconcile', '*/15 * * * *', 'select public.billing_reconcile_tick()');
end
$cron$;

select jobname, schedule, command, active from cron.job where jobname = 'nexar-billing-reconcile';
