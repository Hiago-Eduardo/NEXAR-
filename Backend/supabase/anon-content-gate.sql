-- NEXAR -- Muro de cadastro: visitante sem conta vê uma amostra, não o
-- catálogo inteiro.
--
-- Contexto e decisão (ver CONTEXTO.MD/Resumo.md seção 84):
--   - A BUSCA CONTINUA LIVRE. Quem não tem conta pode pesquisar por nome,
--     categoria e cidade normalmente -- é o que convence a pessoa de que
--     vale a pena se cadastrar. O que é limitado é a QUANTIDADE de
--     resultados, não a capacidade de procurar.
--   - O filtro roda AQUI, no banco, e o corte vem depois dele. Se o corte
--     fosse em 8 linhas fixas (as mais recentes), procurar "embalagens"
--     devolveria zero para o visitante, o que seria pior do que bloquear.
--   - O PERFIL DA EMPRESA (visão agregada: todos os anúncios da conta,
--     catálogo completo, reputação somada) passa a exigir login.
--   - O ANÚNCIO INDIVIDUAL continua aberto -- é a isca, e é o que pode ser
--     indexado/compartilhado.
--
-- Por que no banco e não na tela: hoje a policy deixa qualquer visitante ler
-- a tabela `suppliers` inteira. Limitar só no React seria teatro -- bastaria
-- abrir o painel de rede do navegador para ver a lista completa.
--
-- Arquivo autocontido. PRECISA SER RODADO MANUALMENTE no SQL Editor.
-- Re-executável do início ao fim.

-- ==========================================================================
-- 1) O TAMANHO DA AMOSTRA
-- ==========================================================================

create or replace function public.anon_preview_limit()
 returns integer
 language sql
 immutable
as $function$
  select 8;
$function$;

-- ==========================================================================
-- 2) `suppliers` DEIXA DE SER LEGÍVEL DIRETAMENTE POR ANÔNIMO
--
-- A policy antiga valia para `anon, authenticated`. Agora só authenticated lê
-- a tabela direto; o visitante passa obrigatoriamente pelas RPCs abaixo, que
-- aplicam o limite e devolvem apenas as colunas públicas.
--
-- As funções security definer que já liam suppliers (company_search_public,
-- suppliers_verified_status, company_public_*) continuam funcionando: elas
-- rodam como owner e não passam por RLS.
-- ==========================================================================

-- Derruba os DOIS nomes: o antigo (que valia para anon) e o novo.
--
-- Sem o segundo drop o arquivo NÃO era re-executável, apesar do cabeçalho
-- afirmar que era: na segunda execução o `create policy` abaixo falhava com
-- "policy already exists" e abortava o script inteiro -- inclusive as
-- funções que vêm depois. Foi exatamente o que impediu a correção da busca
-- por tags de chegar ao banco (ver Resumo.md seção 94).
drop policy if exists "Public can read active suppliers, owners read all their own"
  on public.suppliers;
drop policy if exists "Authenticated can read active suppliers, owners read all their own"
  on public.suppliers;

create policy "Authenticated can read active suppliers, owners read all their own"
on public.suppliers
for select
to authenticated
using (
  coalesce(status, 'active') = 'active'
  or auth.uid() = created_by
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 3) LISTAGEM PÚBLICA COM AMOSTRA
--
-- Mesma função para visitante e logado -- quem decide o teto é auth.uid(),
-- não um parâmetro vindo do cliente (parâmetro seria contornável).
--
-- `tags` sai como jsonb via to_jsonb() de propósito: evita depender do tipo
-- exato da coluna (text[] x jsonb), que já causou problema em outra RPC. Do
-- lado do JS chega como array de strings nos dois casos.
-- ==========================================================================

create or replace function public.suppliers_public_list(
  p_search text default null,
  p_category text default null,
  p_city text default null,
  p_limit int default 200
)
 returns table(
   id uuid,
   business_name text,
   category text,
   location text,
   description text,
   tags jsonb,
   rating numeric,
   total_reviews integer,
   logo_url text,
   cover_url text,
   plan text,
   status text,
   min_order text,
   created_at timestamptz
 )
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    s.id,
    s.business_name::text,
    s.category::text,
    s.location::text,
    s.description::text,
    to_jsonb(s.tags),
    s.rating::numeric,
    s.total_reviews::integer,
    s.logo_url::text,
    s.cover_url::text,
    s.plan::text,
    s.status::text,
    s.min_order::text,
    s.created_at
  from public.suppliers s
  where coalesce(s.status, 'active') = 'active'
    and (p_category is null or p_category = '' or s.category = p_category)
    and (
      p_city is null or p_city = ''
      or s.location ilike '%' || p_city || '%'
    )
    and (
      p_search is null or p_search = ''
      or s.business_name ilike '%' || p_search || '%'
      or coalesce(s.description, '') ilike '%' || p_search || '%'
      or coalesce(s.location, '') ilike '%' || p_search || '%'
      -- Tags entram na busca. O filtro em JS que existia antes procurava
      -- nelas; mover o filtro para o banco derrubou isso em silêncio
      -- (regressão da seção 84, encontrada na auditoria da seção 93).
      -- `::text` em vez de unnest/array_to_string porque funciona tanto
      -- para text[] quanto para jsonb -- mesma precaução do to_jsonb().
      or coalesce(s.tags::text, '') ilike '%' || p_search || '%'
    )
  order by s.created_at desc
  limit case
    when auth.uid() is null then public.anon_preview_limit()
    else greatest(coalesce(p_limit, 200), 1)
  end;
$function$;

-- Total real de anúncios que casam com o filtro -- devolvido inclusive para
-- o visitante, de propósito: é o que permite dizer "mostrando 8 de 47" e
-- transformar o limite em argumento de cadastro em vez de esconder o acervo.
create or replace function public.suppliers_public_count(
  p_search text default null,
  p_category text default null,
  p_city text default null
)
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int
  from public.suppliers s
  where coalesce(s.status, 'active') = 'active'
    and (p_category is null or p_category = '' or s.category = p_category)
    and (
      p_city is null or p_city = ''
      or s.location ilike '%' || p_city || '%'
    )
    and (
      p_search is null or p_search = ''
      or s.business_name ilike '%' || p_search || '%'
      or coalesce(s.description, '') ilike '%' || p_search || '%'
      or coalesce(s.location, '') ilike '%' || p_search || '%'
      -- Tags entram na busca. O filtro em JS que existia antes procurava
      -- nelas; mover o filtro para o banco derrubou isso em silêncio
      -- (regressão da seção 84, encontrada na auditoria da seção 93).
      -- `::text` em vez de unnest/array_to_string porque funciona tanto
      -- para text[] quanto para jsonb -- mesma precaução do to_jsonb().
      or coalesce(s.tags::text, '') ilike '%' || p_search || '%'
    );
$function$;

-- ==========================================================================
-- 4) ANÚNCIO INDIVIDUAL -- CONTINUA ABERTO
--
-- Só as colunas públicas. Telefone/email/site/entrega seguem exclusivos de
-- quem tem conta (supabase/contact-info-login-gate.sql) -- o logado não usa
-- esta função, lê a tabela direto com '*'.
-- ==========================================================================

create or replace function public.supplier_public_by_id(p_id uuid)
 returns table(
   id uuid,
   business_name text,
   category text,
   location text,
   description text,
   tags jsonb,
   rating numeric,
   total_reviews integer,
   logo_url text,
   cover_url text,
   plan text,
   status text,
   min_order text,
   created_at timestamptz
 )
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    s.id,
    s.business_name::text,
    s.category::text,
    s.location::text,
    s.description::text,
    to_jsonb(s.tags),
    s.rating::numeric,
    s.total_reviews::integer,
    s.logo_url::text,
    s.cover_url::text,
    s.plan::text,
    s.status::text,
    s.min_order::text,
    s.created_at
  from public.suppliers s
  where s.id = p_id
    and coalesce(s.status, 'active') = 'active';
$function$;

-- ==========================================================================
-- 5) BUSCA POR EMPRESA -- mesma amostra
--
-- `company_search_public` recebe p_limit do cliente, então um visitante
-- poderia simplesmente pedir 500. Ela deixa de ser chamável por anon e ganha
-- um invólucro que fixa o teto com base em auth.uid(). O invólucro é security
-- definer, então a chamada interna continua funcionando.
-- ==========================================================================

create or replace function public.company_search_preview(
  p_search text default null,
  p_category text default null,
  p_city text default null,
  p_limit int default 50,
  p_offset int default 0
)
 returns table (
   representative_supplier_id uuid,
   company_name text,
   avatar_url text,
   cover_url text,
   segment text,
   city text,
   state text,
   category text,
   ad_count bigint,
   rating_avg numeric,
   total_reviews bigint
 )
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select * from public.company_search_public(
    p_search,
    p_category,
    p_city,
    case
      when auth.uid() is null then public.anon_preview_limit()
      else greatest(coalesce(p_limit, 50), 1)
    end,
    case when auth.uid() is null then 0 else coalesce(p_offset, 0) end
  );
$function$;

-- ==========================================================================
-- 6) PERFIL DA EMPRESA -- PASSA A EXIGIR LOGIN
--
-- É a visão agregada da conta (todos os anúncios, catálogo completo,
-- reputação somada). Diferente do anúncio individual, não é vitrine: é
-- pesquisa de fornecedor. Fica atrás do cadastro.
-- ==========================================================================

revoke execute on function public.company_public_profile(uuid) from anon;
revoke execute on function public.company_public_suppliers(uuid) from anon;
revoke execute on function public.company_public_products(uuid) from anon;

-- company_search_public por NOME, varrendo todas as assinaturas.
--
-- A primeira versão deste arquivo revogava citando os 5 parâmetros
-- (text,text,text,int,int) e NÃO funcionou: na verificação o visitante
-- continuava executando a função. A causa provável é uma sobrecarga antiga
-- com assinatura diferente, que o revoke nominal não alcançava -- e que o
-- PostgREST resolvia na chamada sem argumentos. Varrer pg_proc fecha
-- qualquer variante que exista, presente ou futura.
do $revoke_company_search$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'company_search_public'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end
$revoke_company_search$;

-- ==========================================================================
-- 7) GRANTS
-- ==========================================================================

revoke execute on function public.anon_preview_limit() from public;
revoke execute on function public.suppliers_public_list(text, text, text, int) from public;
revoke execute on function public.suppliers_public_count(text, text, text) from public;
revoke execute on function public.supplier_public_by_id(uuid) from public;
revoke execute on function public.company_search_preview(text, text, text, int, int) from public;

grant execute on function public.anon_preview_limit() to anon, authenticated;
grant execute on function public.suppliers_public_list(text, text, text, int) to anon, authenticated;
grant execute on function public.suppliers_public_count(text, text, text) to anon, authenticated;
grant execute on function public.supplier_public_by_id(uuid) to anon, authenticated;
grant execute on function public.company_search_preview(text, text, text, int, int) to anon, authenticated;
