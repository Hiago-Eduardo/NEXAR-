-- ==========================================================================
-- GALERIA DE IMAGENS DO ANÚNCIO (carrossel no SupplierProfile)
--
-- Hoje o anúncio tem UMA imagem: suppliers.cover_url, um campo de texto
-- solto. Esta migração acrescenta uma galeria ordenada, com limite por
-- plano, e faz o cover_url passar a ser DERIVADO dela.     
--
-- ESPELHA product-catalog.sql de propósito. Aquele arquivo já resolveu o
-- mesmo problema para produtos (product_images + limite por plano +
-- trigger), foi verificado contra o banco na seção 136, e copiar a forma que
-- já funciona é melhor do que inventar uma segunda.
--
-- O LOGO NÃO MUDA. suppliers.logo_url continua sendo a marca da empresa,
-- exibida na caixa de 80x80 ao lado do nome. São coisas diferentes: o logo
-- identifica, a galeria mostra o negócio.
-- ==========================================================================


-- ==========================================================================
-- 1) A TABELA
-- ==========================================================================

create table if not exists public.supplier_images (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  url text not null,
  -- `position` define a ordem no carrossel E qual é a capa (a menor).
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists supplier_images_supplier_id_idx
  on public.supplier_images (supplier_id, position);

alter table public.supplier_images enable row level security;

grant select on public.supplier_images to anon, authenticated;
grant insert, update, delete on public.supplier_images to authenticated;

-- Leitura pública: a galeria aparece no anúncio, que é público.
-- Mas SÓ das imagens de anúncios que estão visíveis -- senão a galeria de um
-- anúncio pausado ou suspenso continuaria acessível por quem soubesse o id,
-- o que anularia a suspensão da seção 133 pelo lado das imagens.
drop policy if exists "Public can read supplier images" on public.supplier_images;
create policy "Public can read supplier images"
on public.supplier_images for select
to anon, authenticated
using (
  exists (
    select 1 from public.suppliers s
    where s.id = supplier_id
      and coalesce(s.status, 'active') = 'active'
  )
  or exists (
    select 1 from public.suppliers s
    where s.id = supplier_id and s.created_by = auth.uid()
  )
);

-- Escrita: só o dono do anúncio.
drop policy if exists "Owners can add images to own ads" on public.supplier_images;
create policy "Owners can add images to own ads"
on public.supplier_images for insert
to authenticated
with check (
  exists (
    select 1 from public.suppliers s
    where s.id = supplier_id and s.created_by = auth.uid()
  )
);

drop policy if exists "Owners can reorder images of own ads" on public.supplier_images;
create policy "Owners can reorder images of own ads"
on public.supplier_images for update
to authenticated
using (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.created_by = auth.uid())
)
with check (
  exists (select 1 from public.suppliers s where s.id = supplier_id and s.created_by = auth.uid())
);

drop policy if exists "Owners can delete images from own ads" on public.supplier_images;
create policy "Owners can delete images from own ads"
on public.supplier_images for delete
to authenticated
using (
  exists (
    select 1 from public.suppliers s
    where s.id = supplier_id and s.created_by = auth.uid()
  )
);


-- ==========================================================================
-- 2) LIMITE POR PLANO
--
-- Números decididos com o usuário: básico 3, profissional 5, premium 10.
-- Mais generoso que o limite de fotos POR PRODUTO (1/3/8) porque a galeria
-- do anúncio é a vitrine principal -- é o que a pessoa olha antes de decidir
-- entrar em contato -- enquanto a foto do produto é detalhe.
--
-- ESPELHADO em PLAN_AD_IMAGE_LIMITS (src/lib/plans.js). Mudar aqui exige
-- mudar lá, e há teste travando os dois (plans.test.js).
--
-- Premium é limitado (10, não ilimitado) pelo mesmo motivo das fotos de
-- produto: é uma dimensão que não escala com nada. Um anúncio não fica
-- melhor com 200 fotos, e armazenamento/banda custam.
-- ==========================================================================

create or replace function public.plan_ad_image_limit(plan_id text)
 returns integer
 language sql
 immutable
as $function$
  select case plan_id
    when 'basico' then 3
    when 'profissional' then 5
    when 'premium' then 10
    else 0
  end;
$function$;

create or replace function public.supplier_image_count(p_supplier_id uuid)
 returns integer
 language sql
 stable
as $function$
  select count(*)::int from public.supplier_images where supplier_id = p_supplier_id;
$function$;

create or replace function public.enforce_supplier_image_rules()
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

  select s.created_by into owner_uid from public.suppliers s where s.id = new.supplier_id;

  if public.supplier_image_count(new.supplier_id)
     >= public.plan_ad_image_limit(public.fornecedor_current_plan_id(owner_uid)) then
    raise exception 'PLAN_LIMIT: voce atingiu o limite de imagens do anuncio no seu plano atual.';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_enforce_supplier_image_rules on public.supplier_images;
create trigger trg_enforce_supplier_image_rules
before insert on public.supplier_images
for each row execute function public.enforce_supplier_image_rules();


-- ==========================================================================
-- 3) cover_url PASSA A SER DERIVADO DA GALERIA
--
-- A decisão (tomada com o usuário): a galeria é a FONTE DA VERDADE, e a
-- primeira imagem é a capa. O fornecedor gerencia um lugar só.
--
-- POR QUE UM TRIGGER E NÃO UMA ATUALIZAÇÃO NO AdEditor: se o client fosse o
-- responsável, qualquer outro caminho que mexesse nas imagens deixaria o
-- cover_url desatualizado -- e cover_url é lido pelo cartão da listagem,
-- pela busca e pelo perfil. Um campo derivado mantido à mão é um campo que
-- diverge. No trigger, ele se corrige sozinho venha de onde vier a mudança.
--
-- É a mesma lição de suppliers.plan/verified, que SÃO cópias mantidas à mão
-- e que o CLAUDE.md avisa para nunca usar como fonte da verdade justamente
-- porque ninguém as sincroniza.
--
-- cover_url NÃO é removido: card, busca e perfil já leem esse campo, e
-- mantê-lo preenchido faz tudo continuar funcionando sem alteração.
-- ==========================================================================

create or replace function public.sync_supplier_cover()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_supplier uuid := coalesce(new.supplier_id, old.supplier_id);
  v_capa text;
begin
  select si.url into v_capa
  from public.supplier_images si
  where si.supplier_id = v_supplier
  order by si.position, si.created_at
  limit 1;

  -- coalesce(v_capa, '') e não NULL: o resto do código testa string vazia
  -- (ver o helper `preenchido` em SupplierCard.jsx), porque os campos de
  -- texto deste projeto chegam como '' quando não preenchidos.
  update public.suppliers
  set cover_url = coalesce(v_capa, '')
  where id = v_supplier;

  return null;
end;
$function$;

drop trigger if exists trg_sync_supplier_cover on public.supplier_images;
create trigger trg_sync_supplier_cover
after insert or update or delete on public.supplier_images
for each row execute function public.sync_supplier_cover();


-- ==========================================================================
-- 4) MIGRAÇÃO DOS ANÚNCIOS QUE JÁ TÊM CAPA
--
-- Quem já tem cover_url preenchido ganha essa imagem como a primeira da
-- galeria. Sem isto, a capa atual sumiria da tela no momento em que o
-- carrossel passasse a ler supplier_images -- o fornecedor perderia a imagem
-- que ele já tinha subido, sem ter feito nada.
--
-- `not exists` torna o bloco re-executável: na segunda passada não duplica.
-- ==========================================================================

insert into public.supplier_images (supplier_id, url, position)
select s.id, s.cover_url, 0
from public.suppliers s
where coalesce(s.cover_url, '') <> ''
  and not exists (
    select 1 from public.supplier_images si where si.supplier_id = s.id
  );


notify pgrst, 'reload schema';


-- ==========================================================================
-- COMO CONFERIR
--
--   select count(*) from public.supplier_images;   -- >= nº de anúncios com capa
--
--   select tgname from pg_trigger
--   where tgname in ('trg_enforce_supplier_image_rules','trg_sync_supplier_cover');
--
--   select public.plan_ad_image_limit('profissional');   -- 5
--
-- E pelo comportamento, que é o que vale: subir uma 4ª imagem numa conta
-- básica tem que ser recusado com PLAN_LIMIT, e apagar a primeira imagem
-- tem que trocar o cover_url do anúncio para a seguinte.
--
-- Re-executável: `create table/index if not exists`, `create or replace`,
-- `drop policy/trigger if exists` antes de cada criação, e o insert de
-- migração protegido por `not exists`.
-- ==========================================================================
