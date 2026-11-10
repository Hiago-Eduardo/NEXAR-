-- NEXAR -- Catálogo de produtos por EMPRESA (não mais por anúncio).
--
-- Contexto (ver CONTEXTO.MD/Resumo.md, seções 66-67): até aqui, `products`
-- pertencia a um único anúncio (`supplier_id`), e AdEditor.jsx apagava e
-- recriava todos os produtos do anúncio a cada salvamento -- não existia
-- conceito de produto reaproveitável. A partir de agora:
--   - o produto pertence à CONTA (`products.created_by`, coluna que já
--     existia e já era usada pelas policies de dono -- só não era a fonte
--     de agrupamento até aqui);
--   - uma nova tabela de ligação (`supplier_products`) representa quais
--     produtos do catálogo aparecem em qual anúncio específico;
--   - imagens do produto passam a ser múltiplas (`product_images`),
--     substituindo o antigo `products.image_url` singular.
--
-- Arquivo novo e autocontido (convenção já usada no projeto -- ver
-- rls-policies.sql/company-profile-rpc.sql/company-search-rpc.sql/
-- contact-info-login-gate.sql) em vez de editar os arquivos já verificados
-- contra o banco real. PRECISA SER RODADO MANUALMENTE no SQL Editor do
-- Supabase -- nada aqui é aplicado automaticamente.
--
-- O arquivo INTEIRO é re-executável: rodar de novo (inclusive depois de uma
-- execução que tenha falhado no meio) não duplica dado nem estoura erro de
-- objeto já existente.

-- ==========================================================================
-- 1) ALTERAÇÕES EM `products` + MIGRAÇÃO DE DADOS EXISTENTES
-- ==========================================================================

alter table public.products add column if not exists category text;

create table if not exists public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (supplier_id, product_id)
);

-- Índices dos caminhos quentes. O lado (supplier_id, ...) de
-- supplier_products já é coberto pelo índice da constraint unique acima; o
-- lado product_id (agregação de imagens e lookup reverso) não seria.
create index if not exists product_images_product_id_idx
  on public.product_images (product_id, position);
create index if not exists supplier_products_product_id_idx
  on public.supplier_products (product_id);

-- Preserva o vínculo produto -> anúncio que já existia (1 anúncio por
-- produto até aqui) como uma linha em supplier_products, e migra a foto
-- única (image_url) para product_images (posição 0), ANTES de derrubar as
-- duas colunas antigas.
--
-- Os dois inserts ficam dentro de um bloco plpgsql guardado por
-- information_schema porque numa 2ª execução as colunas `supplier_id` e
-- `image_url` já não existem -- o plpgsql só planeja o comando na hora em
-- que ele de fato executa, então o guard evita o "column does not exist"
-- e deixa o arquivo inteiro re-executável.
do $migrate$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'supplier_id'
  ) then
    insert into public.supplier_products (supplier_id, product_id)
    select p.supplier_id, p.id
    from public.products p
    where p.supplier_id is not null
      -- órfãos (anúncio já apagado) quebrariam a FK -- descartados
      and exists (select 1 from public.suppliers s where s.id = p.supplier_id)
    on conflict (supplier_id, product_id) do nothing;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'image_url'
  ) then
    insert into public.product_images (product_id, url, position)
    select p.id, p.image_url, 0
    from public.products p
    where p.image_url is not null and p.image_url <> ''
      -- não re-migra o que já foi migrado numa execução anterior
      and not exists (
        select 1 from public.product_images pi where pi.product_id = p.id
      );
  end if;
end
$migrate$;

alter table public.products drop column if exists supplier_id;
alter table public.products drop column if exists image_url;

-- ==========================================================================
-- 2) ROW LEVEL SECURITY -- product_images / supplier_products
--
-- Mesmo nível de exposição que `products` já tem hoje (policy "Public can
-- read products" using (true), em rls-policies.sql) -- nenhuma das duas
-- tabelas novas carrega informação de conta (full_name/email/etc), só
-- referências entre ids já públicos, então leitura pública sem RPC.
-- ==========================================================================

alter table public.product_images enable row level security;
alter table public.supplier_products enable row level security;

-- Grants explícitos: o Supabase já concede isso via default privileges
-- quando a tabela é criada pelo `postgres` no SQL Editor, mas repetir aqui
-- deixa o arquivo autossuficiente (RLS sem GRANT não libera acesso nenhum).
grant select on public.product_images to anon, authenticated;
grant insert, delete on public.product_images to authenticated;
grant select on public.supplier_products to anon, authenticated;
grant insert, delete on public.supplier_products to authenticated;

drop policy if exists "Public can read product images" on public.product_images;
create policy "Public can read product images"
on public.product_images
for select
to anon, authenticated
using (true);

drop policy if exists "Owners can add images to own products" on public.product_images;
create policy "Owners can add images to own products"
on public.product_images
for insert
to authenticated
with check (
  exists (
    select 1 from public.products p
    where p.id = product_id and p.created_by = auth.uid()
  )
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Owners can delete images from own products" on public.product_images;
create policy "Owners can delete images from own products"
on public.product_images
for delete
to authenticated
using (
  exists (
    select 1 from public.products p
    where p.id = product_id and p.created_by = auth.uid()
  )
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- Não existe policy de UPDATE em product_images de propósito: Catalogo.jsx
-- só adiciona e remove fotos, nunca altera uma linha existente. Se um dia
-- entrar "arrastar pra reordenar", vai precisar de uma policy de update.

drop policy if exists "Public can read supplier_products" on public.supplier_products;
create policy "Public can read supplier_products"
on public.supplier_products
for select
to anon, authenticated
using (true);

drop policy if exists "Owners can attach own products to own ads" on public.supplier_products;
create policy "Owners can attach own products to own ads"
on public.supplier_products
for insert
to authenticated
with check (
  (
    exists (select 1 from public.suppliers s where s.id = supplier_id and s.created_by = auth.uid())
    and exists (select 1 from public.products p where p.id = product_id and p.created_by = auth.uid())
  )
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Owners can detach products from own ads" on public.supplier_products;
create policy "Owners can detach products from own ads"
on public.supplier_products
for delete
to authenticated
using (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.created_by = auth.uid())
  or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

-- ==========================================================================
-- 3) LIMITES POR PLANO (catálogo) -- mirror em src/lib/plans.js
--    (PLAN_PRODUCT_LIMITS / PLAN_PRODUCT_IMAGE_LIMITS). Igual à convenção já
--    usada por plan_ad_limit(): mudar aqui exige mudar lá também.
-- ==========================================================================

create or replace function public.plan_product_limit(plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select case plan_id
    when 'basico' then 5
    when 'profissional' then 30
    when 'premium' then 2147483647
    else 0
  end;
$function$;

create or replace function public.plan_product_image_limit(plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select case plan_id
    when 'basico' then 1
    when 'profissional' then 3
    when 'premium' then 8
    else 0
  end;
$function$;

create or replace function public.fornecedor_product_count(p_uid uuid)
 returns integer
 language sql
 stable
as $function$
  select count(*)::int from public.products p where p.created_by = p_uid;
$function$;

create or replace function public.product_image_count(p_product_id uuid)
 returns integer
 language sql
 stable
as $function$
  select count(*)::int from public.product_images pi where pi.product_id = p_product_id;
$function$;

-- Bloqueia (RAISE EXCEPTION) criar produto além do limite do plano --
-- mesmo padrão de enforce_supplier_ad_rules() em rls-policies.sql.
create or replace function public.enforce_product_catalog_rules()
 returns trigger
 language plpgsql
as $function$
declare
  is_admin boolean := (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
begin
  if is_admin then
    return new;
  end if;

  if public.fornecedor_product_count(new.created_by)
     >= public.plan_product_limit(public.fornecedor_current_plan_id(new.created_by)) then
    raise exception 'PLAN_LIMIT: voce atingiu o limite de produtos do catalogo no seu plano atual.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_product_catalog_rules on public.products;
create trigger trg_enforce_product_catalog_rules
before insert on public.products
for each row execute function public.enforce_product_catalog_rules();

-- Mesma lógica para imagem por produto -- o dono relevante pra saber o
-- plano é o dono do PRODUTO (products.created_by), não de quem chama.
create or replace function public.enforce_product_image_rules()
 returns trigger
 language plpgsql
as $function$
declare
  is_admin boolean := (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin';
  owner_uid uuid;
begin
  if is_admin then
    return new;
  end if;

  select p.created_by into owner_uid from public.products p where p.id = new.product_id;

  if public.product_image_count(new.product_id)
     >= public.plan_product_image_limit(public.fornecedor_current_plan_id(owner_uid)) then
    raise exception 'PLAN_LIMIT: voce atingiu o limite de imagens por produto do seu plano atual.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_product_image_rules on public.product_images;
create trigger trg_enforce_product_image_rules
before insert on public.product_images
for each row execute function public.enforce_product_image_rules();

-- plan_product_limit/plan_product_image_limit/fornecedor_product_count/
-- product_image_count/enforce_product_catalog_rules/enforce_product_image_rules
-- ficam com o grant padrão do Postgres (EXECUTE para PUBLIC), mesma
-- justificativa já usada para as funções equivalentes de anúncio: não
-- expõem nada que as policies acima já não deixem acessível, e as duas
-- funções de trigger não são chamáveis via RPC/PostgREST.

-- ==========================================================================
-- 4) RPC PÚBLICA -- catálogo completo da empresa (para SupplierProfile.jsx
--    ?view=empresa). Mesmo padrão de company_public_suppliers (ver
--    supabase/company-profile-rpc.sql): resolve o dono do anúncio
--    internamente a partir do supplier_id, sem expor created_by ao cliente.
--    Devolve as imagens já agregadas (jsonb, ordenadas por posição) para
--    evitar uma consulta extra por produto.
--
--    Os casts explícitos no select não são decorativos: uma função SQL com
--    `returns table` estoura em tempo de EXECUÇÃO ("structure of query does
--    not match function result type") se o tipo real da coluna divergir do
--    declarado -- ex.: price gravado como float8, min_quantity como numeric.
-- ==========================================================================

create or replace function public.company_public_products(p_supplier_id uuid)
 returns table(
   id uuid,
   name text,
   description text,
   category text,
   price numeric,
   unit text,
   min_quantity integer,
   in_stock boolean,
   created_at timestamptz,
   images jsonb
 )
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    p.id,
    p.name::text,
    p.description::text,
    p.category::text,
    p.price::numeric,
    p.unit::text,
    p.min_quantity::integer,
    p.in_stock::boolean,
    p.created_at,
    coalesce(
      (select jsonb_agg(pi.url order by pi.position)
       from public.product_images pi
       where pi.product_id = p.id),
      '[]'::jsonb
    ) as images
  from public.products p
  where p.created_by = (
    select s1.created_by from public.suppliers s1 where s1.id = p_supplier_id
  )
  order by p.created_at desc nulls last;
$function$;

revoke execute on function public.company_public_products(uuid) from public;
grant execute on function public.company_public_products(uuid) to anon, authenticated;
