-- NEXAR -- perfil criado no servidor no cadastro (confirmação de e-mail).
--
-- Por quê (Resumo.md seções 207-208): com "Confirm email" ligado no painel
-- (mailer_autoconfirm = false), o supabase.auth.signUp volta SEM sessão. O
-- Register.jsx gravava user_profiles logo depois do signUp, com a sessão
-- -- sem ela a RLS recusa, e toda conta nova ficava sem perfil (CNPJ, razão
-- social, telefone... perdidos).
--
-- Agora o Register manda os dados do formulário em
-- options.data.nexar_profile (vai para auth.users.raw_user_meta_data) e este
-- trigger cria a linha de user_profiles NA HORA do cadastro, no servidor.
-- Funciona mesmo se a pessoa confirmar no celular e entrar no computador.
--
-- Garantias:
--  * Só campos conhecidos, cortados no tamanho; user_type só 'fornecedor'
--    ou 'cliente' (nunca role/admin -- papel de admin continua em
--    app_metadata, que o cliente não escreve).
--  * created_by = id da conta recém-criada e email = e-mail da conta: o
--    metadado não escolhe dono.
--  * Já existe perfil para a conta -> não faz nada.
--  * FALHA NÃO BLOQUEIA O CADASTRO: qualquer erro (ex.: CNPJ recusado por
--    trg_enforce_user_profile_cnpj) vira WARNING e a conta é criada sem
--    perfil -- a pessoa completa em Minha Conta, como antes.
--  * Depois de gravar, tira nexar_profile do raw_user_meta_data: o
--    user_metadata vai dentro de todo JWT, e CNPJ/telefone não precisam
--    viajar em cada requisição.
--  * Contas antigas e o login não são tocados (só AFTER INSERT).
--
-- PRÉ-REQUISITOS: supabase/user-profile-cep.sql (coluna cep) já rodado --
-- o bloco abaixo recusa rodar sem ela.
-- ANTES DE RODAR, conferir se não há outro trigger criando perfil:
--   select tgname, tgfoid::regproc from pg_trigger
--   where tgrelid = 'auth.users'::regclass and not tgisinternal;
-- (se aparecer um handle_new_user que insere em user_profiles, avisar --
-- os dois juntos não duplicam, por causa do "já existe", mas é redundante.)
--
-- RODAR MANUALMENTE no SQL Editor do Supabase. Idempotente.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'cep'
  ) then
    raise exception 'Rode supabase/user-profile-cep.sql antes deste arquivo.';
  end if;
end;
$$;

begin;

create or replace function public.nexar_create_profile_on_signup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p jsonb := new.raw_user_meta_data -> 'nexar_profile';
  v_tipo text;
  v_cep text;
  v_uf text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return new;
  end if;

  begin
    if exists (select 1 from public.user_profiles where created_by = new.id) then
      return new;
    end if;

    v_tipo := case when p ->> 'user_type' = 'fornecedor' then 'fornecedor' else 'cliente' end;
    v_cep := regexp_replace(coalesce(p ->> 'cep', ''), '[^0-9]', '', 'g');
    v_cep := case when v_cep ~ '^[0-9]{8}$' then v_cep else null end;
    v_uf := upper(btrim(coalesce(p ->> 'state', '')));
    v_uf := case when v_uf ~ '^[A-Z]{2}$' then v_uf else null end;

    insert into public.user_profiles
      (created_by, email, user_type, full_name, cnpj, company_name, phone, cep, city, state, segment)
    values (
      new.id,
      lower(new.email),
      v_tipo,
      left(nullif(btrim(p ->> 'full_name'), ''), 200),
      left(nullif(btrim(p ->> 'cnpj'), ''), 18),
      left(nullif(btrim(p ->> 'company_name'), ''), 200),
      left(nullif(btrim(p ->> 'phone'), ''), 30),
      v_cep,
      left(nullif(btrim(p ->> 'city'), ''), 120),
      v_uf,
      left(nullif(btrim(p ->> 'segment'), ''), 60)
    );

    update auth.users
    set raw_user_meta_data = raw_user_meta_data - 'nexar_profile'
    where id = new.id;
  exception when others then
    raise warning 'nexar_create_profile_on_signup: perfil não criado para % (%): %',
      new.id, sqlstate, sqlerrm;
  end;

  return new;
end;
$$;

revoke execute on function public.nexar_create_profile_on_signup() from public, anon, authenticated;

drop trigger if exists nexar_create_profile_on_signup on auth.users;
create trigger nexar_create_profile_on_signup
after insert on auth.users
for each row execute function public.nexar_create_profile_on_signup();

commit;

-- Conferência (leitura):
--   select tgname from pg_trigger where tgname = 'nexar_create_profile_on_signup';
--
-- Contas criadas SEM perfil desde que a confirmação foi ligada (seção 207)
-- -- não são corrigidas por este trigger (só vale para cadastros novos):
--   select u.id, u.email, u.created_at, u.email_confirmed_at
--   from auth.users u
--   where not exists (select 1 from public.user_profiles p where p.created_by = u.id)
--   order by u.created_at desc;
