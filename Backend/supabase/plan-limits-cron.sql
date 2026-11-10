-- ==========================================================================
-- LIMITES DE PLANO -- AGENDADOR (pg_cron)
--
-- Faz vencimentos, viradas de downgrade e suspensões valerem SEM depender de
-- o fornecedor abrir o Dashboard (Resumo.md seção 185). Chama
-- public.run_plan_maintenance() (plan-limits-central.sql) a cada 10 minutos.
--
-- RODE SÓ DEPOIS de plan-limits-central.sql E de conferir a PRÉVIA que ela
-- mostra: na primeira passada o agendador aplica a regra a TODAS as contas
-- -- é aqui que as contas existentes passam a ser ajustadas.
--
-- POR QUE pg_cron: roda dentro do próprio Postgres, como `postgres`, sem
-- chave de serviço fora do banco, sem Edge Function, sem servidor -- o NEXAR
-- não tem nenhum dos três. É extensão oficial do Supabase.
-- Na etapa 1 ele apareceu só como "não fazer NESTA etapa" (escopo), nunca
-- como inseguro; a falta de agendador está registrada como problema desde a
-- seção 113.
--
-- PRÉ-REQUISITO: extensão habilitada em Database > Extensions > pg_cron.
-- Sem ela este arquivo PARA no primeiro bloco, com a instrução.
--
-- RE-EXECUTÁVEL: desagenda o job de mesmo nome antes de agendar.
-- Para desligar: select cron.unschedule('nexar-plan-maintenance');
-- ==========================================================================

do $verifica$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'PG_CRON_INDISPONIVEL: habilite em Database > Extensions > pg_cron e rode este arquivo de novo.';
  end if;
  if not exists (select 1 from pg_proc where proname = 'run_plan_maintenance') then
    raise exception 'FALTA_CENTRAL: rode supabase/plan-limits-central.sql antes deste arquivo.';
  end if;
end
$verifica$;

select cron.unschedule(jobid) from cron.job where jobname = 'nexar-plan-maintenance';

select cron.schedule(
  'nexar-plan-maintenance',
  '*/10 * * * *',
  $job$select public.run_plan_maintenance()$job$
);

-- Primeira passada agora, para não esperar 10 minutos -- e para o resultado
-- aparecer aqui embaixo.
select public.run_plan_maintenance() as primeira_passada,
       (select jsonb_agg(jsonb_build_object('jobid', jobid, 'schedule', schedule, 'command', command, 'active', active))
          from cron.job where jobname = 'nexar-plan-maintenance') as job;

-- ==========================================================================
-- COMO ACOMPANHAR
--   select * from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'nexar-plan-maintenance')
--   order by start_time desc limit 20;
--
--   select created_by, event_type, metadata, created_at
--   from public.subscription_events
--   where event_type in ('plan_limits_applied', 'plan_limits_failed')
--   order by created_at desc limit 50;
--
-- cron.job_run_details cresce uma linha a cada 10 minutos (~4.300/mês). O
-- Supabase recomenda limpar de tempos em tempos:
--   delete from cron.job_run_details where end_time < now() - interval '7 days';
-- ==========================================================================
