-- ==========================================================================
-- SELO DE PLANO SEMPRE EM DIA -- suppliers.plan acompanha a assinatura
-- (seção 163)
-- ==========================================================================
--
-- O PROBLEMA: `suppliers.plan` é uma cópia do plano da conta, gravada pelo
-- AdEditor só quando o anúncio é SALVO. Depois de um upgrade, downgrade ou
-- de uma troca agendada entrar em vigor, cada anúncio continuava mostrando o
-- plano antigo -- no selo do Dashboard, no cartão da listagem e no filtro
-- "Fornecedores em Destaque" da Home (FeaturedSuppliers.jsx) -- até o
-- fornecedor abrir e salvar o anúncio de novo. Um Premium recém-contratado
-- não aparecia em Destaque.
--
-- A CORREÇÃO: um trigger em `subscriptions`. Toda mudança numa assinatura
-- (contratar, trocar, promover agendamento, expirar) reescreve o plano de
-- TODOS os anúncios daquela conta com o plano vigente, calculado por
-- fornecedor_current_plan_id() -- a mesma função que o banco já usa para os
-- limites. A tela não calcula nada.
--
-- Trocas que só dependem do RELÓGIO (a data do agendamento chegou) viram
-- UPDATE em subscriptions quando sync_my_subscription() roda -- o Dashboard
-- chama ao abrir --, e aí este trigger dispara.
--
-- SEM PLANO VIGENTE, o plano do anúncio NÃO é apagado: os anúncios dessa
-- conta estão suspensos (fora do site) e manter o último plano evita
-- esbarrar em qualquer CHECK/NOT NULL de suppliers.plan.
--
-- ADITIVO: cria 1 função e 1 trigger, e acerta os anúncios que já estão
-- desatualizados. Não altera nenhuma função existente. Pode rodar de novo.
-- Não interfere no enforce_supplier_ad_rules: ele só valida quando o anúncio
-- é ATIVADO, e aqui só a coluna `plan` muda.
-- ==========================================================================

create or replace function public.sync_supplier_plan_from_subscription()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_plan text;
begin
  v_plan := public.fornecedor_current_plan_id(new.created_by);
  if v_plan is not null then
    update public.suppliers
    set plan = v_plan
    where created_by = new.created_by
      and plan is distinct from v_plan;
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_sync_supplier_plan on public.subscriptions;
create trigger trg_sync_supplier_plan
after insert or update on public.subscriptions
for each row execute function public.sync_supplier_plan_from_subscription();

-- Função de trigger: não é chamável via RPC; tira o EXECUTE padrão mesmo
-- assim, para não aparecer como endpoint.
revoke execute on function public.sync_supplier_plan_from_subscription() from public, anon, authenticated;

-- Acerto único: anúncios que JÁ estão com o plano velho. Sem isto, só
-- mudariam na próxima mudança de assinatura da conta.
update public.suppliers s
set plan = p.plan_id
from (
  select distinct created_by, public.fornecedor_current_plan_id(created_by) as plan_id
  from public.suppliers
) p
where s.created_by = p.created_by
  and p.plan_id is not null
  and s.plan is distinct from p.plan_id;
