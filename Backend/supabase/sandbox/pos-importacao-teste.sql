-- ==========================================================================
-- DEPOIS DE IMPORTAR E MARCAR -- SÓ NO PROJETO DE TESTE (§235)
--
-- Religa os privilégios padrão do Supabase em public (os mesmos do
-- principal), para que os arquivos rodados DEPOIS (fix-paid-plan-activation,
-- asaas-billing, ...) se comportem como em produção: criam com o padrão e
-- revogam o que precisam. Não mexe em nenhum objeto já importado.
-- Exige o marcador (01-marcar-projeto-teste.sql).
-- ==========================================================================

do $pos$
begin
  if to_regclass('nexar_sandbox.marcador') is null then
    raise exception 'Sem o marcador do projeto de teste. Nada foi alterado.';
  end if;
  alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
end
$pos$;

select 'default privileges de public (postgres)' as item, defaclobjtype as tipo, defaclacl::text as acl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace and pg_get_userbyid(defaclrole) = 'postgres';
