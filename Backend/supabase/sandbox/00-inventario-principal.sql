-- ==========================================================================
-- INVENTÁRIO DO PROJETO PRINCIPAL -- SÓ LEITURA (Resumo.md §235)
--
-- Rodar no SQL Editor do projeto PRINCIPAL (tzbawflkcivprblqzqjk), com a
-- autorização do usuário, ANTES de montar o projeto de teste. Só SELECT:
-- nenhum BEGIN, DO, escrita ou função criada. Não lê dados de usuários,
-- cobranças nem segredos -- só metadados (nomes, contagens, definições).
--
-- Serve para listar o que `supabase db dump` NÃO exporta (esquemas auth e
-- storage, objetos de extensões, jobs do pg_cron, Vault, configurações) e
-- precisa ser recriado à mão no projeto de teste. Cole o resultado na
-- conversa.
-- ==========================================================================

-- 1) TODOS os triggers em tabelas de auth/storage (o dump ignora esses
--    esquemas). Sem filtro de nome: um trigger criado pelo painel também tem
--    de aparecer; os do próprio Supabase você reconhece e ignora.
select '1 trigger fora de public' as secao,
       format('%s.%s', n.nspname, c.relname) as item,
       format('%s -> %s', t.tgname, t.tgfoid::regprocedure) as valor
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal
  and n.nspname in ('auth', 'storage')

union all
-- 2) Buckets do Storage (nome, público, limites) -- sem listar arquivos
select '2 bucket', id, format('public=%s limite=%s tipos=%s', public, coalesce(file_size_limit::text, '-'),
                              coalesce(array_to_string(allowed_mime_types, ','), '-'))
from storage.buckets

union all
-- 3) Policies do Storage (storage.objects / buckets)
select '3 policy storage', format('%s."%s"', tablename, policyname),
       format('cmd=%s roles=%s using=%s check=%s', cmd, roles::text, coalesce(qual, '-'), coalesce(with_check, '-'))
from pg_policies where schemaname = 'storage'

union all
-- 4) Extensões instaladas (as que o teste precisa habilitar)
select '4 extensão', extname, format('versão %s, esquema %s', extversion, extnamespace::regnamespace)
from pg_extension

union all
-- 5) Jobs do pg_cron (NÃO são exportados -- e NÃO devem ser copiados todos:
--    no teste só entra o da reconciliação; ver HOMOLOGACAO.md)
select '5 cron', jobname, format('%s | ativo=%s', schedule, active)
from cron.job

union all
-- 6) Nomes dos segredos do Vault (só NOMES, nunca valores)
select '6 vault (só nome)', name, '-'
from vault.secrets

union all
-- 7) Privilégios padrão de public (o dump pode não reproduzir)
select '7 default privileges', format('%s em %s', defaclobjtype, defaclnamespace::regnamespace),
       defaclacl::text
from pg_default_acl

union all
-- 8) Funções nossas fora de public (deveriam ser zero)
select '8 função fora de public', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
from pg_proc p
where p.pronamespace in ('auth'::regnamespace, 'storage'::regnamespace)
  and pg_get_userbyid(p.proowner) = 'postgres'

union all
-- 9) Publicações (Realtime)
select '9 publicação', pubname, format('todas=%s', puballtables)
from pg_publication

union all
-- 10) Tamanho do que NÃO vamos copiar (só contagem, para conferir o dump)
select '10 linhas (não copiar)', t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', t), false, true, '')))[1]::text
from unnest(array['subscriptions', 'payments', 'suppliers', 'products', 'user_profiles', 'notifications']) t
where to_regclass('public.' || t) is not null

order by 1, 2;
