-- ==========================================================================
-- CHAT ENDEREÇADO PELA CONTA, NÃO PELO E-MAIL DO ANÚNCIO (seção 166)
-- ==========================================================================
--
-- O PROBLEMA: o chat identifica as pessoas por e-mail (sender_id /
-- receiver_id são texto com o e-mail). O botão "Chat" do anúncio usava
-- `suppliers.email` -- o E-MAIL DE CONTATO que o fornecedor digita no
-- AdEditor -- como endereço do fornecedor. Se esse e-mail não fosse o do
-- LOGIN dele, a mensagem ia para um endereço sem conta e ninguém a via.
-- Nada avisava. O anúncio [TESTE] estava assim (comercial@... x login
-- testerclaude@...). E o fornecedor, ao responder, gravava o e-mail de LOGIN
-- em sender_id, que o cliente lia nos dados do chat.
--
-- A CORREÇÃO:
--  * duas colunas novas, sender_user_id / receiver_user_id (uuid da conta),
--    que passam a ser o endereço de verdade;
--  * um trigger BEFORE INSERT decide TUDO do lado do servidor:
--      - quem envia é sempre auth.uid() -- o sender_id que o navegador manda
--        é ignorado (não dá mais para se passar por outro e-mail);
--      - conversa de anúncio (ad_id preenchido):
--          cliente -> dono:  destino = dono do anúncio (suppliers.created_by);
--                            receiver_id vira o id do ANÚNCIO;
--          dono -> cliente:  remetente aparece como o ANÚNCIO (sender_id =
--                            id do anúncio, sender_name = nome do anúncio) --
--                            o e-mail de login do fornecedor nunca vai para
--                            o cliente; destino = o outro participante da
--                            conversa;
--      - conversa sem anúncio (antiga): destino = o outro participante, ou a
--        conta cujo e-mail é o receiver_id;
--  * leitura: policy nova (ADITIVA -- as de e-mail continuam valendo para as
--    mensagens antigas) por sender_user_id / receiver_user_id;
--  * inserção: policy nova que aceita a linha quando sender_user_id é o
--    próprio chamador. Necessária porque o trigger reescreve sender_id para o
--    id do anúncio, e a policy antiga exige sender_id = e-mail do JWT. Como o
--    trigger FORÇA sender_user_id = auth.uid(), ninguém insere em nome de
--    outro.
--  * as 3 funções de não lidas (chat-read-receipts.sql) são REESCRITAS para
--    olhar receiver_user_id, com o e-mail como reserva para linhas antigas.
--  * acerto único das mensagens existentes -- inclusive as que foram para o
--    e-mail de contato e ninguém leu: passam a chegar ao dono do anúncio.
--
-- *** SOBRESCREVE my_unread_message_count / mark_conversation_read /
-- mark_all_messages_read de chat-read-receipts.sql. Se aquele arquivo for
-- rodado DE NOVO depois deste, as versões antigas (só por e-mail) voltam sem
-- erro nenhum. Rode este por último. ***
--
-- Pode rodar de novo (if not exists / create or replace / drop if exists).
-- ==========================================================================

-- 1) Colunas -----------------------------------------------------------------
alter table public.chat_messages
  add column if not exists sender_user_id uuid references auth.users(id) on delete set null,
  add column if not exists receiver_user_id uuid references auth.users(id) on delete set null;

create index if not exists chat_messages_sender_user on public.chat_messages (sender_user_id);
create index if not exists chat_messages_receiver_user on public.chat_messages (receiver_user_id);
create index if not exists chat_messages_unread_by_receiver_user
  on public.chat_messages (receiver_user_id)
  where read is not true;

-- 2) Acerto das mensagens existentes ----------------------------------------
-- Remetente: created_by já é o uuid de quem enviou.
update public.chat_messages
set sender_user_id = created_by
where sender_user_id is null and created_by is not null;

-- Destino em conversa de anúncio, mensagem do CLIENTE: o dono do anúncio.
-- Aqui entram as mensagens enviadas para um e-mail de contato sem conta.
update public.chat_messages m
set receiver_user_id = s.created_by
from public.suppliers s
where m.receiver_user_id is null
  and m.ad_id = s.id
  and m.sender_user_id is distinct from s.created_by;

-- Destino pelo e-mail, quando ele é o de uma conta.
update public.chat_messages m
set receiver_user_id = u.id
from auth.users u
where m.receiver_user_id is null
  and lower(u.email) = lower(m.receiver_id);

-- O que sobrar: o outro participante da mesma conversa.
update public.chat_messages m
set receiver_user_id = (
  select o.sender_user_id from public.chat_messages o
  where o.conversation_id = m.conversation_id
    and o.sender_user_id is not null
    and o.sender_user_id is distinct from m.sender_user_id
  order by o.created_at desc
  limit 1
)
where m.receiver_user_id is null;

-- 3) Trigger que decide remetente e destino ---------------------------------
create or replace function public.route_chat_message()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_ad_name text;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  new.sender_user_id := v_uid;
  new.created_by := v_uid;
  -- Remetente decidido aqui, não pelo navegador.
  new.sender_id := lower(auth.jwt() ->> 'email');
  new.receiver_user_id := null;

  if new.ad_id is not null then
    select s.created_by, s.business_name into v_owner, v_ad_name
    from public.suppliers s where s.id = new.ad_id;
  end if;

  if v_owner is not null and v_owner <> v_uid then
    -- Cliente escrevendo para o anúncio: vai para o DONO, qualquer que seja
    -- o e-mail de contato do anúncio.
    new.receiver_user_id := v_owner;
    new.receiver_id := new.ad_id::text;
    new.receiver_name := coalesce(v_ad_name, new.receiver_name);
  else
    if v_owner is not null and v_owner = v_uid then
      -- Dono respondendo: aparece como o anúncio, nunca como o e-mail dele.
      new.sender_id := new.ad_id::text;
      new.sender_name := coalesce(v_ad_name, new.sender_name);
    end if;

    -- Destino: o outro participante da conversa...
    select o.sender_user_id into new.receiver_user_id
    from public.chat_messages o
    where o.conversation_id = new.conversation_id
      and o.sender_user_id is not null
      and o.sender_user_id <> v_uid
    order by o.created_at desc
    limit 1;

    -- ...ou, na primeira mensagem sem anúncio, a conta daquele e-mail.
    if new.receiver_user_id is null and new.receiver_id is not null then
      select u.id into new.receiver_user_id
      from auth.users u where lower(u.email) = lower(new.receiver_id);
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_route_chat_message on public.chat_messages;
create trigger trg_route_chat_message
before insert on public.chat_messages
for each row execute function public.route_chat_message();

revoke execute on function public.route_chat_message() from public, anon, authenticated;

-- 4) Policies ADITIVAS (as de e-mail continuam valendo) ---------------------
drop policy if exists "Participants by account can read chat messages" on public.chat_messages;
create policy "Participants by account can read chat messages"
on public.chat_messages
for select
to authenticated
using (sender_user_id = auth.uid() or receiver_user_id = auth.uid());

drop policy if exists "Senders by account can create chat messages" on public.chat_messages;
create policy "Senders by account can create chat messages"
on public.chat_messages
for insert
to authenticated
with check (auth.uid() = created_by and sender_user_id = auth.uid());

-- 5) Não lidas pela conta (substitui as de chat-read-receipts.sql) -----------
create or replace function public.my_unread_message_count()
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int from public.chat_messages
  where read is not true
    and (
      receiver_user_id = auth.uid()
      or (receiver_user_id is null and lower(receiver_id) = lower(auth.jwt() ->> 'email'))
    );
$function$;

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
    and read is not true
    and (
      receiver_user_id = auth.uid()
      or (receiver_user_id is null and lower(receiver_id) = lower(auth.jwt() ->> 'email'))
    );
  get diagnostics n = row_count;
  return n;
end;
$function$;

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
  where read is not true
    and (
      receiver_user_id = auth.uid()
      or (receiver_user_id is null and lower(receiver_id) = lower(auth.jwt() ->> 'email'))
    );
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
