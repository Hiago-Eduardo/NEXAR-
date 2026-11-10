-- =========================================================================
-- LEITURA DE MENSAGENS DO CHAT -- contador de não lidas (seção 156)
-- ==========================================================================
--
-- ADITIVO: não altera tabela, coluna nem policy existente. Só cria 3 funções
-- e 1 índice. Pode rodar em qualquer ordem em relação aos outros arquivos, e
-- rodar de novo é inofensivo (create or replace / if not exists).
--
-- O PROBLEMA: `chat_messages.read` (boolean) existe desde sempre, mas nunca
-- foi gravado. E não tinha como: a policy de update em chat_messages
-- ("Senders can update chat messages", rls-policies.sql) só deixa o
-- REMETENTE alterar a mensagem -- e quem marca como lida é o DESTINATÁRIO.
--
-- POR QUE RPC E NÃO UMA POLICY NOVA: uma policy de update para o
-- destinatário liberaria a linha INTEIRA para ele (texto, remetente,
-- conversa). RLS não restringe coluna. A função security definer só sabe
-- fazer uma coisa: pôr read = true nas mensagens em que quem chama é o
-- destinatário. Mesmo padrão de mark_notification_read
-- (payments-audit-notifications.sql).
--
-- IDENTIDADE: sender_id/receiver_id guardam o EMAIL, não o uuid (legado --
-- ver CLAUDE.md). A comparação é lower() dos dois lados, igual à policy de
-- select de chat_messages.
--
-- `read is not true` em vez de `read = false`: cobre linhas com read NULL,
-- que nunca foram gravadas. O índice parcial usa o MESMO predicado e a MESMA
-- expressão lower(receiver_id), senão o Postgres não o usa.
-- ==========================================================================

create index if not exists chat_messages_unread_by_receiver
  on public.chat_messages (lower(receiver_id))
  where read is not true;

-- Quantas mensagens recebidas ainda não lidas. Alimenta o número ao lado de
-- "Mensagens" na NavBar.
create or replace function public.my_unread_message_count()
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int from public.chat_messages
  where lower(receiver_id) = lower(auth.jwt() ->> 'email')
    and read is not true;
$function$;

-- Marca como lidas as mensagens RECEBIDAS de uma conversa. Chamada quando a
-- pessoa abre a conversa no Chat. Devolve quantas mudaram.
create or replace function public.mark_conversation_read(p_conversation_id text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n integer;
begin
  update public.chat_messages
  set read = true
  where conversation_id = p_conversation_id
    and lower(receiver_id) = lower(auth.jwt() ->> 'email')
    and read is not true;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- Marca como lidas TODAS as mensagens recebidas. Usada pelo "Marcar todas
-- como lidas" da tela de Notificações, que lista mensagens de chat junto com
-- os avisos do sistema.
create or replace function public.mark_all_messages_read()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n integer;
begin
  update public.chat_messages
  set read = true
  where lower(receiver_id) = lower(auth.jwt() ->> 'email')
    and read is not true;
  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke execute on function public.my_unread_message_count() from public, anon;
revoke execute on function public.mark_conversation_read(text) from public, anon;
revoke execute on function public.mark_all_messages_read() from public, anon;
grant execute on function public.my_unread_message_count() to authenticated;
grant execute on function public.mark_conversation_read(text) to authenticated;
grant execute on function public.mark_all_messages_read() to authenticated;
