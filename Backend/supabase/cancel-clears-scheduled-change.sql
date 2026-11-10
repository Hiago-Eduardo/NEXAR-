-- ==========================================================================
-- CANCELAR O PLANO TAMBÉM DESFAZ A TROCA AGENDADA
--
-- SUBSTITUI a versão de `cancel_my_subscription` que está em
-- supabase/rls-policies.sql (seção 11 daquele arquivo). Nada mais muda: o
-- resto de rls-policies.sql continua valendo integralmente.
--
-- >>> SE ALGUÉM RE-RODAR rls-policies.sql DEPOIS DESTE ARQUIVO, A VERSÃO SEM
-- >>> O DELETE VOLTA EM SILÊNCIO -- e o bug volta junto, sem nada quebrar na
-- >>> tela. Rode este depois. Mesma armadilha de
-- >>> plan-change-at-period-end.sql; a ordem entre os dois não importa,
-- >>> porque eles tocam em funções diferentes. <<<
--
-- ---------------------------------------------------------------- O BUG ---
-- Encontrado na auditoria da seção 116. `cancel_my_subscription` mexia só na
-- linha VIGENTE e nunca olhava para status='scheduled'.
--
-- O caminho, todo ele pela interface:
--   1. fornecedor no Premium agenda a troca para Profissional
--      -> subscribe_to_plan cria uma linha 'scheduled' com
--         started_at = expires_at do Premium
--   2. ele clica "Cancelar plano" no Dashboard. O diálogo promete, com
--      estas palavras, "Não haverá renovação automática."
--      -> o Premium vira 'cancelled' e vale até o vencimento
--      -> A LINHA 'scheduled' CONTINUA VIVA
--   3. no vencimento, sync_my_subscription() passo (b) promove essa linha
--      para 'active' com expires_at = +30 dias
--
-- Resultado: quem cancelou ganha um plano pago novo. Hoje não custa dinheiro
-- porque Pagamento.jsx é fachada (não há gateway), mas vira cobrança
-- indevida no dia em que entrar um -- por isso está sendo corrigido agora, e
-- não quando o gateway chegar.
--
-- A função que faz exatamente este delete JÁ EXISTIA
-- (cancel_scheduled_plan_change, em subscription-plan-change.sql). Ela só
-- nunca era chamada no cancelamento -- só pelo botão "Desfazer troca" da
-- tela de Planos. O conserto é ligar as duas coisas.
--
-- ------------------------------------------------- POR QUE DELETE, E NÃO ---
-- ------------------------------------------------- GUARDAR PARA DEPOIS   ---
-- "Cancelar plano" é a pessoa dizendo que quer SAIR. Manter viva uma troca
-- que ela contratou enquanto queria ficar é manter uma intenção que deixou
-- de existir. O delete é o que torna VERDADEIRA a frase que o diálogo já
-- mostra.
--
-- CONSEQUÊNCIA ACEITA, e ela é real: `reactivate_my_subscription` NÃO
-- ressuscita o agendamento. Quem cancela e reativa volta para o plano que
-- tinha, sem a troca -- se ainda quiser trocar, agenda de novo pela tela de
-- Planos. A alternativa (guardar o agendamento em algum status 'suspenso'
-- para restaurar na reativação) exigiria um quarto estado no ciclo de vida e
-- um caminho novo em sync_my_subscription, para atender um caso raro
-- (cancelar, se arrepender, E querer a troca de volta) cuja recuperação
-- manual custa dois cliques. Não compensa.
--
-- O delete é incondicional de propósito: não existe caso em que cancelar
-- deva preservar o agendamento, e um `if` a mais só criaria um ramo sem
-- teste. Também é inofensivo quando não há nada agendado -- deleta zero
-- linhas.
-- ==========================================================================

create or replace function public.cancel_my_subscription()
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'active' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_ACTIVE_SUBSCRIPTION';
  end if;

  -- NOVO (seção 116): desfaz a troca agendada junto com o cancelamento.
  -- Vem ANTES do update para que, se algo abaixo falhar, a transação
  -- inteira volte atrás -- assinatura cancelada e agendamento vivo é
  -- exatamente o estado que este arquivo existe para impedir.
  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  if v_row.plan_id = 'basico' then
    -- Plano gratuito: nao ha carencia paga a preservar, cancelamento e imediato.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), expires_at = now()
    where id = v_row.id
    returning * into v_row;
  else
    -- Plano pago: mantem expires_at original -- fornecedor continua com os beneficios
    -- ate o vencimento, so nao havera renovacao automatica.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now()
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.cancel_my_subscription() from public;
grant execute on function public.cancel_my_subscription() to authenticated;

notify pgrst, 'reload schema';

-- ==========================================================================
-- COMO CONFERIR QUE ESTA VERSÃO É A QUE ESTÁ NO BANCO
--
-- A lição da seção 110: quando um arquivo SUBSTITUI uma função que já
-- existia, testar "a função responde" NÃO PROVA NADA -- a versão antiga
-- responderia igual, e o revoke/grant daqui é idêntico ao de rls-policies.
-- Tem que olhar o corpo:
--
--   select position('status = ''scheduled''' in prosrc) > 0 as tem_o_delete
--   from pg_proc where proname = 'cancel_my_subscription';
--
-- Esperado: tem_o_delete = true.
--
-- Estruturalmente re-executável: é `create or replace` puro mais
-- revoke/grant, sem DDL de tabela, policy ou trigger. Pela regra da seção
-- 94, só vira re-executável VERIFICADO depois de uma segunda execução sem
-- erro.
-- ==========================================================================
