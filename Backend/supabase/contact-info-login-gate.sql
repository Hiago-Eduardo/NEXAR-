-- Restringe informações de CONTATO do anúncio (telefone, email, site,
-- info de entrega) para quem tem conta (authenticated) -- visitante sem
-- login (anon) só vê a prévia (nome, descrição, categoria, localização,
-- avaliação, pedido mínimo). Decisão de produto: planos pagos são só do
-- FORNECEDOR (ver plans.js/subscription.js); nenhum campo devia ficar
-- escondido do cliente por causa do plano de quem anunciou -- só o login
-- do próprio visitante decide o que ele vê. Ver CONTEXTO.MD/Resumo.md.
--
-- min_order ("pedido mínimo") fica de fora deste gate de propósito: já é
-- usado sem restrição nenhuma pelo filtro "Faixa de pedido mínimo" da
-- listagem pública (Suppliers.jsx) -- é tratado como dado de prévia/
-- comparação, não como informação de contato.
--
-- IMPORTANTE: revoke por coluna (não por linha -- RLS já cuida disso).
-- authenticated mantém o grant padrão do Supabase (select em todas as
-- colunas) sem alteração -- este revoke é só pra anon. Qualquer leitura
-- pública (anon) de suppliers precisa agora pedir colunas explícitas, sem
-- essas 4, ou o select inteiro falha (Postgres nega a coluna, não retorna
-- as outras como null) -- ver src/pages/Home.jsx, src/pages/Suppliers.jsx
-- e src/pages/SupplierProfile.jsx (fetch condicional por useAuth()).
--
-- CORREÇÃO (2026-09-17, primeira versão não funcionou): revoke por coluna
-- sozinho é um NO-OP se a role já tiver select na TABELA TODA (o que o
-- Supabase já concede por padrão pra anon, é assim que o resto da tabela
-- fica público) -- Postgres não deixa um revoke de coluna mais estreito
-- sobrepor um grant de tabela mais amplo que já existe. Testado direto na
-- API (curl) depois de rodar só o revoke por coluna: email/phone/website
-- continuaram voltando pra anon. Por isso agora revoga a tabela inteira
-- de anon e concede de volta só as colunas seguras -- mesma lista de
-- SUPPLIER_PUBLIC_COLUMNS em src/api/client.js, têm que ficar em sincronia.

revoke select on public.suppliers from anon;

grant select (
  id, business_name, category, location, description, tags, rating,
  total_reviews, logo_url, cover_url, plan, status, min_order, created_at
) on public.suppliers to anon;

-- company_public_profile: mesma regra pro telefone da empresa (é a única
-- coluna de contato que essa RPC expõe). Resto da função sem mudança --
-- ver supabase/company-profile-rpc.sql pro contexto completo dela.
create or replace function public.company_public_profile(p_supplier_id uuid)
 returns table(company_name text, segment text, phone text, city text, state text, avatar_url text, cover_url text, company_description text, company_description_available boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    up.company_name,
    up.segment,
    case when auth.uid() is not null then up.phone else null end as phone,
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
