-- ===========================================================================
-- NEXAR -- LIMPEZA TOTAL DOS DADOS.  IRREVERSÍVEL.  (Resumo.md seção 212)
-- ===========================================================================
--
-- Apaga TODOS os dados: contas (auth.users, inclusive as de teste),
-- perfis, anúncios, produtos, imagens (linhas), avaliações, pedidos de
-- orçamento, chat, assinaturas, pagamentos, notificações, logs.
--
-- NÃO apaga a estrutura: tabelas, colunas, funções, triggers, policies,
-- grants, jobs do pg_cron e as regras de plano (que são funções) ficam.
--
-- ORDEM:
--   0. BACKUP (ver Resumo.md seção 212 / resposta no chat).
--   1. Rode a PARTE 1 (só leitura) e confira a lista. Se aparecer alguma
--      tabela de CONFIGURAÇÃO que deva ficar, NÃO rode a parte 2 -- avise.
--   2. Esvazie o bucket de imagens PELO PAINEL: Storage -> uploads -> ...
--      -> Empty bucket. (O Supabase bloqueia apagar storage.objects por
--      SQL; a parte 2 se recusa a rodar enquanto houver arquivo lá.)
--   3. Rode a PARTE 2 sozinha (selecione só ela e execute).
--
-- Depois: as contas de teste do .env.local (TEST_FORNECEDOR_*,
-- TEST_CLIENTE_*) deixam de existir -- recrie pelo /Register e atualize o
-- .env.local, senão o npm run e2e e o test:banco falham no login.
-- ===========================================================================


-- ===========================================================================
-- PARTE 1 -- PRÉVIA (SÓ LEITURA). Rode e confira.
-- ===========================================================================

select table_name as tabela,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint as linhas
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
union all
select 'auth.users (contas)', count(*) from auth.users
union all
select 'storage.objects bucket ' || bucket_id, count(*) from storage.objects group by bucket_id
order by 1;


-- ===========================================================================
-- PARTE 2 -- APAGA TUDO. Só depois da prévia, do backup e do bucket vazio.
-- ===========================================================================

begin;

do $$
declare
  v_tabelas text;
  v_arquivos bigint;
begin
  select count(*) into v_arquivos from storage.objects where bucket_id = 'uploads';
  if v_arquivos > 0 then
    raise exception 'O bucket uploads ainda tem % arquivo(s). Esvazie pelo painel (Storage -> uploads -> Empty bucket) e rode de novo.', v_arquivos;
  end if;

  -- Todas as tabelas de public de uma vez. TRUNCATE não dispara os
  -- triggers de linha (nenhuma notificação, e-mail ou auditoria é gerada).
  select string_agg(format('public.%I', tablename), ', ' order by tablename)
  into v_tabelas
  from pg_tables
  where schemaname = 'public';

  if v_tabelas is not null then
    execute 'truncate table ' || v_tabelas || ' restart identity cascade';
  end if;

  -- Contas. Sessões, identidades e fatores do Auth saem em cascata.
  delete from auth.users;
end;
$$;

commit;

-- Conferência (leitura): tudo deve dar 0. O bloco acima é tudo-ou-nada --
-- se qualquer passo falhou, nada foi apagado.
select table_name as tabela,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint as linhas
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
union all
select 'auth.users (contas)', count(*) from auth.users
order by 1;

