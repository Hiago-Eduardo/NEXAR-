-- ==========================================================================
-- ANTES DE IMPORTAR O ESQUEMA -- SÓ NO PROJETO DE TESTE RECÉM-CRIADO (§235)
--
-- Por quê: um projeto Supabase novo dá a anon/authenticated/service_role,
-- por PRIVILÉGIO PADRÃO, acesso a toda tabela/função criada em public. O
-- pg_dump grava as permissões em relação ao padrão do PRÓPRIO Postgres, não
-- ao do Supabase: importando com os padrões ligados, o que o principal
-- REVOGOU (funções internas, escrita em tabelas financeiras...) VOLTA no
-- teste -- e fix-paid-plan-activation.sql aborta, ou pior, o teste fica
-- mais fraco que a produção. Desligando os padrões antes, os objetos nascem
-- só com o padrão do Postgres e o dump reproduz as permissões exatas.
-- Depois da importação: pos-importacao-teste.sql religa os padrões.
--
-- Recusa rodar num banco que já tenha tabelas do NEXAR, usuários ou
-- assinaturas (ou seja, recusa o principal).
-- ==========================================================================

do $pre$
begin
  if to_regclass('public.subscriptions') is not null or to_regclass('public.suppliers') is not null then
    raise exception 'Este banco já tem o esquema do NEXAR (é o principal ou já foi importado). Nada foi alterado.';
  end if;
  if exists (select 1 from auth.users) then
    raise exception 'Este banco já tem usuários: não é um projeto de teste recém-criado. Nada foi alterado.';
  end if;

  alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
  alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
  alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
end
$pre$;

select 'default privileges de public (postgres)' as item, defaclobjtype as tipo, defaclacl::text as acl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace and pg_get_userbyid(defaclrole) = 'postgres';
