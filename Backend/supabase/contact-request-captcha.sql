-- NEXAR -- pedido de orçamento com Turnstile: a gravação (Resumo.md §228).
-- PREPARADO, NÃO RODADO. ADITIVO: não muda policy, grant nem função existente.
--
-- A Edge Function submit-contact-request confere o CAPTCHA (Siteverify) e
-- então chama esta RPC com o usuário JÁ CONFERIDO pelo JWT. Só service_role
-- executa: nem anon nem authenticated alcançam a função, então ninguém grava
-- por aqui sem passar pela Cloudflare.
--
-- Mesmas regras da policy de insert de hoje (rls-policies.sql §6: dono do
-- pedido = quem pede), mais: o anúncio precisa existir. O trigger
-- trg_email_from_contact_request (e-mail ao dono do anúncio) continua
-- disparando, inclusive a regra "pedido ao próprio anúncio não gera e-mail".
--
-- Sozinho, este arquivo NÃO fecha nada: o insert direto pelo PostgREST
-- continua aberto até rodar contact-request-captcha-lock.sql (último passo).
--
-- RODAR MANUALMENTE no SQL Editor. Idempotente.

create or replace function public.submit_contact_request(
  p_user uuid,
  p_supplier_id uuid,
  p_sender_name text,
  p_sender_email text,
  p_sender_phone text,
  p_message text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'USER_NOT_FOUND';
  end if;
  if p_supplier_id is null or not exists (select 1 from public.suppliers s where s.id = p_supplier_id) then
    raise exception 'SUPPLIER_NOT_FOUND';
  end if;
  if coalesce(btrim(p_sender_name), '') = '' or coalesce(btrim(p_sender_email), '') = '' or coalesce(btrim(p_message), '') = '' then
    raise exception 'INVALID_FIELDS';
  end if;

  insert into public.contact_requests (supplier_id, created_by, sender_name, sender_email, sender_phone, message)
  values (
    p_supplier_id, p_user,
    left(btrim(p_sender_name), 120),
    left(btrim(p_sender_email), 254),
    -- "" quando vazio, igual ao formulário de hoje (não muda o dado gravado).
    left(btrim(coalesce(p_sender_phone, '')), 40),
    left(btrim(p_message), 5000)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.submit_contact_request(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_contact_request(uuid, uuid, text, text, text, text) to service_role;

-- Conferência (leitura):
--   select has_function_privilege('authenticated', 'public.submit_contact_request(uuid, uuid, text, text, text, text)', 'execute'); -- false
--   select has_function_privilege('service_role',  'public.submit_contact_request(uuid, uuid, text, text, text, text)', 'execute'); -- true
