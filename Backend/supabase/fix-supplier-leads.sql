-- ===========================================================================
-- NEXAR -- Correção das métricas de contatos (leads). Resumo.md seções 216-217.
-- ===========================================================================
--
-- A VIEW public.supplier_leads (definição lida do banco em 2026-10-20; não
-- existia em nenhum arquivo do repositório) alimenta "Contatos recebidos" e o
-- gráfico de contatos do Dashboard (my_lead_counts / my_daily_stats, em
-- rls-policies.sql). Dois defeitos:
--
--  1. VAZAMENTO: anon e authenticated tinham TODOS os privilégios na view.
--     Como view comum roda com os direitos do dono (postgres), ela passava
--     por cima do RLS de contact_requests e chat_messages: qualquer visitante
--     lia qual e-mail de cliente contatou qual anúncio e quando.
--  2. CONTAGEM INFLADA: o lead do chat era lower(sender_id). Desde
--     chat-by-account.sql a RESPOSTA DO DONO sai com sender_id = id do
--     anúncio, então toda conversa respondida virava +1 contato. E o mesmo
--     cliente podia contar duas vezes: no pedido o lead era o e-mail
--     DIGITADO no formulário (sender_email), no chat o e-mail de login.
--
-- CORREÇÃO
--  * Lead = CONTA do cliente (uuid): pedido -> created_by; chat ->
--    sender_user_id. Linha antiga sem uuid: tenta achar a conta pelo e-mail
--    em auth.users; sem conta, fica o e-mail (como antes).
--  * Fora do lead: tudo que vem da conta DONA do anúncio (respostas no chat,
--    pedido que o dono mandou para si mesmo testando).
--  * Mesmas colunas e tipos (supplier_id, lead_key, first_contact_at): as
--    funções que leem a view não mudam.
--  * REVOKE ALL de anon/authenticated. As funções my_lead_counts e
--    my_daily_stats são security definer (dono postgres) e continuam lendo.
--  * Dias no fuso de Brasília: register_ad_view grava viewed_on e
--    my_daily_stats agrupa pelo dia de America/Sao_Paulo (o banco está em
--    UTC: o dia virava às 21h). Linhas antigas de ad_views ficam como estão.
--
-- SOBRESCREVE register_ad_view e my_daily_stats de rls-policies.sql: rodar
-- rls-policies.sql de novo depois desfaz o fuso (não o vazamento nem a
-- contagem, que moram na view).
--
-- ORDEM: rode a PARTE 1 (só leitura) e confira; depois a PARTE 2 sozinha.
-- ===========================================================================


-- ===========================================================================
-- PARTE 1 -- PRÉVIA (SÓ LEITURA): contatos por anúncio hoje x depois.
-- ===========================================================================

with novo as (
  select supplier_id, lead_key from (
    select cr.supplier_id,
           coalesce(cr.created_by,
                    (select u.id from auth.users u where lower(u.email) = lower(cr.sender_email) limit 1)
           )::text as conta,
           lower(cr.sender_email) as email,
           s.created_by as dono
    from public.contact_requests cr
    join public.suppliers s on s.id = cr.supplier_id
    union all
    select m.ad_id,
           coalesce(m.sender_user_id,
                    (select u.id from auth.users u where lower(u.email) = lower(m.sender_id) limit 1)
           )::text,
           lower(m.sender_id),
           s.created_by
    from public.chat_messages m
    join public.suppliers s on s.id = m.ad_id
  ) x(supplier_id, conta, email, dono),
  lateral (select coalesce(conta, nullif(email, ''))) k(lead_key)
  where lead_key is not null
    and (conta is null or conta <> dono::text)
    and email is distinct from supplier_id::text
  group by supplier_id, lead_key
)
select s.business_name as anuncio,
       (select count(*) from public.supplier_leads l where l.supplier_id = s.id) as contatos_hoje,
       (select count(*) from novo n where n.supplier_id = s.id) as contatos_depois
from public.suppliers s
order by 1;


-- ===========================================================================
-- PARTE 2 -- APLICA. Tudo-ou-nada: se um teste do fim falhar, nada muda.
-- ===========================================================================

begin;

create or replace view public.supplier_leads as
select supplier_id, lead_key, min(first_contact_at) as first_contact_at
from (
  select cr.supplier_id,
         coalesce(
           coalesce(cr.created_by,
                    (select u.id from auth.users u where lower(u.email) = lower(cr.sender_email) limit 1)
           )::text,
           nullif(lower(cr.sender_email), '')
         ) as lead_key,
         cr.created_at as first_contact_at,
         coalesce(cr.created_by,
                  (select u.id from auth.users u where lower(u.email) = lower(cr.sender_email) limit 1)
         ) as conta,
         s.created_by as dono,
         lower(cr.sender_email) as email
  from public.contact_requests cr
  join public.suppliers s on s.id = cr.supplier_id
  union all
  select m.ad_id,
         coalesce(
           coalesce(m.sender_user_id,
                    (select u.id from auth.users u where lower(u.email) = lower(m.sender_id) limit 1)
           )::text,
           nullif(lower(m.sender_id), '')
         ),
         m.created_at,
         coalesce(m.sender_user_id,
                  (select u.id from auth.users u where lower(u.email) = lower(m.sender_id) limit 1)),
         s.created_by,
         lower(m.sender_id)
  from public.chat_messages m
  join public.suppliers s on s.id = m.ad_id
) combined
where lead_key is not null
  and conta is distinct from dono              -- respostas e testes do próprio dono
  and email is distinct from supplier_id::text -- resposta do dono sem uuid (sender_id = id do anúncio)
group by supplier_id, lead_key;

-- Ninguém de fora lê a view; só as funções security definer.
revoke all on public.supplier_leads from anon, authenticated, public;

create or replace function public.register_ad_view(p_supplier_id uuid, p_session_id text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select created_by into v_owner from public.suppliers where id = p_supplier_id;
  if v_owner is null then
    return;
  end if;

  if v_uid is not null and v_uid = v_owner then
    return;
  end if;

  if v_uid is not null then
    insert into public.ad_views (supplier_id, viewer_user_id, viewed_on)
    values (p_supplier_id, v_uid, v_hoje)
    on conflict do nothing;
  elsif p_session_id is not null and length(p_session_id) between 8 and 100 then
    insert into public.ad_views (supplier_id, viewer_session_id, viewed_on)
    values (p_supplier_id, p_session_id, v_hoje)
    on conflict do nothing;
  end if;
end;
$function$;

revoke execute on function public.register_ad_view(uuid, text) from public;
grant execute on function public.register_ad_view(uuid, text) to anon, authenticated;

create or replace function public.my_daily_stats(p_days integer default 30)
 returns table(day date, views bigint, contacts bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  with hoje as (
    select (now() at time zone 'America/Sao_Paulo')::date as d
  ),
  days as (
    select generate_series(h.d - (greatest(p_days, 1) - 1), h.d, interval '1 day')::date as day
    from hoje h
  ),
  my_supplier_ids as (
    select id from public.suppliers where created_by = auth.uid()
  ),
  daily_views as (
    select viewed_on as day, count(*)::bigint as views
    from public.ad_views
    where supplier_id in (select id from my_supplier_ids)
    group by viewed_on
  ),
  daily_leads as (
    select (first_contact_at at time zone 'America/Sao_Paulo')::date as day, count(*)::bigint as contacts
    from public.supplier_leads
    where supplier_id in (select id from my_supplier_ids)
    group by 1
  )
  select d.day, coalesce(dv.views, 0), coalesce(dl.contacts, 0)
  from days d
  left join daily_views dv on dv.day = d.day
  left join daily_leads dl on dl.day = d.day
  order by d.day;
$function$;

revoke execute on function public.my_daily_stats(integer) from public;
grant execute on function public.my_daily_stats(integer) to authenticated;

-- Testes. Qualquer falha aborta a transação inteira.
do $$
begin
  if has_table_privilege('anon', 'public.supplier_leads', 'select') then
    raise exception 'FALHOU: anon ainda lê supplier_leads';
  end if;
  if has_table_privilege('authenticated', 'public.supplier_leads', 'select') then
    raise exception 'FALHOU: authenticated ainda lê supplier_leads';
  end if;
  if exists (
    select 1 from public.supplier_leads l join public.suppliers s on s.id = l.supplier_id
    where l.lead_key = s.created_by::text or l.lead_key = s.id::text
  ) then
    raise exception 'FALHOU: o dono do anúncio ainda conta como contato';
  end if;
  if not has_function_privilege('anon', 'public.register_ad_view(uuid, text)', 'execute') then
    raise exception 'FALHOU: anon perdeu register_ad_view';
  end if;
  raise notice 'OK: supplier_leads fechada, sem respostas do dono, fuso de Brasília.';
end;
$$;

commit;

-- Conferência (leitura): contatos por anúncio depois da correção.
select s.business_name as anuncio, count(l.lead_key) as contatos
from public.suppliers s
left join public.supplier_leads l on l.supplier_id = s.id
group by s.business_name
order by 1;
