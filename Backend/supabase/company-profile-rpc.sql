-- NEXAR -- RPCs de perfil público da EMPRESA (dona de um anúncio),
-- usadas por SupplierProfile.jsx?view=empresa.
--
-- Reconstruído em 2026-09-17 a partir do que está DE FATO rodando no
-- Supabase (dump via pg_proc, feito com o usuário direto no SQL Editor).
-- A versão anterior deste arquivo continha só o texto de um prompt/bug
-- report antigo (sobre um bug de navegação client-side, já corrigido em
-- SupplierProfile.jsx) salvo por engano com extensão .sql -- não era SQL
-- executável e não refletia o banco real. Ver CONTEXTO.MD/Resumo.md
-- seções 42-45 pra esse histórico.
--
-- Ambas são security definer: user_profiles não tem policy de select
-- público (ver rls-policies.sql, seção 5) -- essas RPCs resolvem o dono do
-- anúncio internamente e devolvem só as colunas comerciais já
-- consideradas públicas (nunca full_name, email, cnpj, role/user_type nem
-- nenhuma coluna de subscriptions).
--
-- Este arquivo é só para consulta/histórico -- já está tudo aplicado no
-- Supabase.

-- company_description só é devolvida se o dono do anúncio tem plano pago
-- (profissional/premium) usável agora -- mesma regra de
-- hasUsableBenefits() em src/lib/subscription.js, replicada aqui em SQL
-- porque essa função roda no banco, não no client.
create or replace function public.company_public_profile(p_supplier_id uuid)
 returns table(company_name text, segment text, phone text, city text, state text, avatar_url text, cover_url text, company_description text, company_description_available boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    up.company_name,
    up.segment,
    up.phone,
    up.city,
    up.state,
    up.avatar_url,
    up.cover_url,
    case when has_paid_plan.usable then up.company_description else null end as company_description,
    coalesce(has_paid_plan.usable, false) as company_description_available
  from public.suppliers s
  left join public.user_profiles up on up.created_by = s.created_by
  left join lateral (
    select exists (
      select 1
      from public.subscriptions sub
      where sub.created_by = s.created_by
        and sub.plan_id in ('profissional', 'premium')
        and sub.status in ('active', 'cancelled')
        and sub.expires_at > now()
    ) as usable
  ) has_paid_plan on true
  where s.id = p_supplier_id
  limit 1;
$function$;

revoke execute on function public.company_public_profile(uuid) from public;
grant execute on function public.company_public_profile(uuid) to anon, authenticated;

-- Todos os anúncios ATIVOS da mesma empresa (mesmo created_by), incluindo
-- o anúncio de origem se ele estiver ativo -- nunca agrupados por
-- nome/categoria/cidade, sempre pelo dono real.
create or replace function public.company_public_suppliers(p_supplier_id uuid)
 returns setof suppliers
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select s2.*
  from public.suppliers s2
  where s2.created_by = (
    select s1.created_by from public.suppliers s1 where s1.id = p_supplier_id
  )
  and coalesce(s2.status, 'active') = 'active'
  order by s2.created_at desc nulls last;
$function$;

revoke execute on function public.company_public_suppliers(uuid) from public;
grant execute on function public.company_public_suppliers(uuid) to anon, authenticated;
