-- ==========================================================================
-- RETRATO DAS PERMISSÕES DE public -- SÓ LEITURA (§235)
--
-- Mesmo arquivo nos DOIS projetos: no PRINCIPAL antes de exportar e no
-- TESTE logo depois de importar (antes de 01-marcar...). Exporte cada
-- resultado como CSV (botão do SQL Editor) e compare:
--   Compare-Object (Get-Content principal.csv) (Get-Content teste.csv)
-- Tem de dar VAZIO. Diferença = a importação não reproduziu as permissões
-- (ver HOMOLOGACAO.md, passo 3) -- não siga adiante.
-- Lista só o que anon/authenticated podem; nada de dados.
-- ==========================================================================

select 'funcao' as tipo, p.oid::regprocedure::text as objeto,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated
from pg_proc p
where p.pronamespace = 'public'::regnamespace
union all
select 'tabela:' || priv, c.relname,
       has_table_privilege('anon', c.oid, priv),
       has_table_privilege('authenticated', c.oid, priv)
from pg_class c
cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'm', 'p')
union all
select 'rls', c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
order by 1, 2;
