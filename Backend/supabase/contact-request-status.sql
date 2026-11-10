-- ==========================================================================
-- PEDIDO DE ORÇAMENTO: o DONO DO ANÚNCIO marca como respondido/fechado
-- (seção 163)
-- ==========================================================================
--
-- O PROBLEMA: contact_requests.status existe, mas a policy de update
-- ("Users can update contact requests", rls-policies.sql) só aceita quem
-- ENVIOU o pedido. O fornecedor, que é quem responde, nunca conseguia mudar
-- o status -- o Dashboard mostrava "Pendente" para sempre, e a seção 162
-- tirou o selo por isso.
--
-- POR QUE RPC E NÃO UMA POLICY NOVA: uma policy de update para o dono do
-- anúncio liberaria a linha INTEIRA (mensagem, nome, e-mail de quem pediu).
-- RLS não restringe coluna. Esta função só sabe mudar `status`, e só em
-- pedidos de anúncios do próprio chamador. Mesmo desenho de
-- mark_conversation_read (chat-read-receipts.sql).
--
-- Status aceitos: 'pending', 'replied', 'closed' -- os três que a interface
-- já conhecia (Dashboard.jsx). A coluna é texto livre no banco; a lista vale
-- aqui.
--
-- ADITIVO: cria 1 função. Não altera tabela nem policy. Pode rodar de novo.
-- ==========================================================================

create or replace function public.set_contact_request_status(p_id uuid, p_status text)
 returns public.contact_requests
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.contact_requests;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_status is null or p_status not in ('pending', 'replied', 'closed') then
    raise exception 'INVALID_STATUS';
  end if;

  update public.contact_requests cr
  set status = p_status
  where cr.id = p_id
    and exists (
      select 1 from public.suppliers s
      where s.id = cr.supplier_id and s.created_by = v_uid
    )
  returning cr.* into v_row;

  -- Pedido inexistente OU de anúncio de outra conta: a mesma resposta, para
  -- não revelar se o id existe.
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.set_contact_request_status(uuid, text) from public, anon;
grant execute on function public.set_contact_request_status(uuid, text) to authenticated;
