-- ==========================================================================
-- CORREÇÃO: visitante sem conta não conseguia ler a galeria do anúncio
--
-- O BUG, e é meu (seção 139). A policy de SELECT de supplier_images tinha
-- dois `exists` sobre public.suppliers, e o segundo lia s.created_by:
--
--     or exists (select 1 from public.suppliers s
--                where s.id = supplier_id and s.created_by = auth.uid())
--
-- `anon` NÃO TEM SELECT em suppliers.created_by -- é coluna restrita, como
-- phone/email/website/delivery_info (supabase/contact-info-login-gate.sql).
-- Quando o Postgres avalia a policy para um visitante sem conta, esbarra na
-- coluna negada e RECUSA A CONSULTA INTEIRA:
--
--     401 / 42501  permission denied
--     hint: GRANT SELECT ON public.suppliers TO anon
--
-- Resultado: a galeria só funcionava logado. Como a página do anúncio é
-- PÚBLICA e o carrossel é o conteúdo principal dela, o recurso estava
-- quebrado justamente para o público a que se destina.
--
-- POR QUE EU ERREI: copiei a forma da policy de product_images
-- (product-catalog.sql), que faz o mesmo `exists` sobre public.products. Só
-- que `products` NÃO tem revoke por coluna, e `suppliers` TEM. Copiei o
-- padrão sem conferir que a tabela do join tinha grants diferentes.
-- A LIÇÃO: policy que consulta outra tabela herda as restrições de coluna do
-- CHAMADOR. Em `suppliers`, qualquer policy avaliada por anon só pode tocar
-- colunas públicas -- ou tem que passar por security definer.
--
-- A CORREÇÃO usa o padrão que este projeto já tem para leitura pública
-- segura: uma função `security definer` resolve a visibilidade internamente,
-- com os privilégios do dono da função, e a policy só chama a função. O
-- valor devolvido é um booleano -- nenhuma coluna restrita chega ao cliente.
-- ==========================================================================

create or replace function public.can_read_supplier_images(p_supplier_id uuid)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.suppliers s
    where s.id = p_supplier_id
      and (
        -- anúncio visível ao público...
        coalesce(s.status, 'active') = 'active'
        -- ...ou é o dono olhando o próprio, inclusive pausado/suspenso,
        -- senão ele não conseguiria gerenciar as imagens no AdEditor.
        or s.created_by = auth.uid()
      )
  );
$function$;

grant execute on function public.can_read_supplier_images(uuid) to anon, authenticated;

drop policy if exists "Public can read supplier images" on public.supplier_images;
create policy "Public can read supplier images"
on public.supplier_images for select
to anon, authenticated
using (public.can_read_supplier_images(supplier_id));

notify pgrst, 'reload schema';

-- ==========================================================================
-- COMO CONFERIR -- e aqui só o comportamento vale, porque a policy antiga
-- também "existia" e respondia; ela é que recusava.
--
-- Como ANÔNIMO (sem header Authorization), a leitura tem que devolver 200 e
-- as imagens dos anúncios ativos:
--   GET /rest/v1/supplier_images?select=id,supplier_id,url,position
--
-- Antes desta correção: 401 / 42501.
--
-- As policies de INSERT/UPDATE/DELETE não precisaram mudar: são
-- `to authenticated`, e usuário logado PODE ler suppliers.created_by.
--
-- Re-executável: create or replace + drop policy if exists.
-- ==========================================================================
