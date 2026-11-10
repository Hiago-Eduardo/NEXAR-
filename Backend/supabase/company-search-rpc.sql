-- Busca de EMPRESAS (uma linha por empresa, agregando os anúncios ativos
-- dela) para a aba "Empresas" da tela de Fornecedores (src/pages/Suppliers.jsx).
--
-- Por que uma RPC security definer: user_profiles não tem policy de select
-- público (só o dono/admin lê a própria linha via RLS — ver rls-policies.sql).
-- suppliers já é público (Suppliers.jsx lê a tabela direto), então o único
-- motivo para "definer" aqui é poder juntar user_profiles.company_name/
-- avatar_url/segment/city/state/cover_url a essa agregação sem relaxar a RLS
-- de user_profiles. Mesmo padrão de company_public_profile/
-- company_public_suppliers (ver CLAUDE.md > "Security-definer RPC pattern").
--
-- Nunca devolve full_name, email, cnpj, role/user_type nem nenhuma coluna de
-- subscriptions -- só os campos comerciais já expostos publicamente em
-- company_public_profile, mais os agregados de suppliers.
--
-- Executar manualmente no SQL editor do Supabase (nenhum passo de build faz
-- isso automaticamente).

create or replace function public.company_search_public(
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
security definer
set search_path = public
stable
as $$
  with active_ads as (
    select
      s.id,
      s.created_by,
      s.business_name,
      s.category,
      s.location,
      s.description,
      s.rating,
      s.total_reviews,
      s.created_at,
      row_number() over (partition by s.created_by order by s.created_at desc) as rn
    from public.suppliers s
    where coalesce(s.status, 'active') = 'active'
  ),
  -- Anúncio representante de cada empresa (o mais recente) -- via DISTINCT ON
  -- em vez de max()/min(), que não têm agregação definida para uuid.
  representative as (
    select distinct on (a.created_by)
      a.created_by,
      a.id as representative_supplier_id,
      a.business_name as representative_business_name,
      a.location as representative_location,
      a.category as representative_category
    from active_ads a
    order by a.created_by, a.rn
  ),
  stats as (
    select
      a.created_by,
      count(*) as ad_count,
      avg(a.rating) filter (where a.rating > 0) as rating_avg,
      sum(coalesce(a.total_reviews, 0)) as total_reviews,
      array_agg(distinct a.category) as categories,
      string_agg(distinct lower(a.business_name), ' ') as ads_name_blob,
      string_agg(distinct lower(coalesce(a.description, '')), ' ') as ads_desc_blob,
      string_agg(distinct lower(coalesce(a.location, '')), ' ') as ads_location_blob
    from active_ads a
    group by a.created_by
  )
  select
    r.representative_supplier_id,
    coalesce(up.company_name, r.representative_business_name) as company_name,
    up.avatar_url,
    up.cover_url,
    up.segment,
    coalesce(up.city, r.representative_location) as city,
    up.state,
    r.representative_category as category,
    s.ad_count,
    round(s.rating_avg::numeric, 1) as rating_avg,
    s.total_reviews
  from representative r
  join stats s on s.created_by = r.created_by
  left join public.user_profiles up on up.created_by = r.created_by
  where
    (p_search is null or p_search = '' or
      lower(coalesce(up.company_name, '')) like '%' || lower(p_search) || '%' or
      s.ads_name_blob like '%' || lower(p_search) || '%' or
      s.ads_desc_blob like '%' || lower(p_search) || '%')
    and (p_category is null or p_category = '' or
      p_category = up.segment or p_category = any(s.categories))
    and (p_city is null or p_city = '' or
      lower(coalesce(up.city, '')) like '%' || lower(p_city) || '%' or
      lower(coalesce(up.state, '')) like '%' || lower(p_city) || '%' or
      s.ads_location_blob like '%' || lower(p_city) || '%')
  order by s.ad_count desc, rating_avg desc nulls last
  limit greatest(coalesce(p_limit, 50), 0)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Sem este revoke, EXECUTE fica liberado pra PUBLIC (grant padrão do
-- Postgres em toda function nova) além de anon/authenticated -- diferente
-- do padrão já usado por company_public_profile/company_public_suppliers
-- (supabase/company-profile-rpc.sql), que fecham esse grant default. Sem
-- efeito prático hoje (PUBLIC inclui anon/authenticated de qualquer jeito
-- neste projeto), mas destoa do least-privilege que o resto do banco segue.
revoke execute on function public.company_search_public(text, text, text, int, int) from public;
grant execute on function public.company_search_public(text, text, text, int, int) to anon, authenticated;
