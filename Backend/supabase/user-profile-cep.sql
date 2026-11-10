-- NEXAR -- CEP da conta/empresa (user_profiles.cep).
--
-- ADITIVO e mínimo: uma coluna nova, opcional, e um CHECK de formato.
-- Nenhuma policy, função, grant ou trigger existente é alterado. A RLS de
-- user_profiles (só o dono lê/escreve a própria linha) cobre a coluna nova
-- automaticamente -- a tabela não usa grant por coluna. Não toca em
-- suppliers, assinaturas, planos nem catálogo. Ver CONTEXTO.MD/Resumo.md,
-- seção 205.
--
-- Formato: TEXTO com exatamente 8 dígitos ("01001000"), sem máscara --
-- texto para não perder o zero à esquerda; a máscara 00000-000 é só de tela
-- (src/lib/cep.js). NULL = não informado (CEP não é obrigatório).
--
-- Público? NÃO. company_public_profile / company_search_public listam as
-- colunas que devolvem e não incluem cep. Rua e bairro do ViaCEP nem são
-- gravados.
--
-- Antes desta migração o app já funciona: o front tenta gravar o CEP e, se
-- a coluna não existir, grava o resto sem ele (saveWithOptionalCep).
--
-- RODAR MANUALMENTE no SQL Editor do Supabase. Idempotente.

begin;

alter table public.user_profiles
  add column if not exists cep text;

alter table public.user_profiles
  drop constraint if exists user_profiles_cep_format;

alter table public.user_profiles
  add constraint user_profiles_cep_format
  check (cep is null or cep ~ '^[0-9]{8}$');

commit;

-- Conferência (leitura):
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'cep';
--   -> cep | text | YES
--
-- Isolamento entre contas (RLS, inalterada): com o JWT da conta A,
--   PATCH /rest/v1/user_profiles?id=eq.<id de um perfil da conta B>  { "cep": "01001000" }
-- devolve [] (zero linhas).
