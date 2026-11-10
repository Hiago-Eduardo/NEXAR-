-- NEXAR -- Contagem de anúncios por categoria (grid da Home).
--
-- Contexto (ver CONTEXTO.MD/Resumo.md seção 87): o grid "Explore por
-- categoria" listava as 10 categorias sem dizer o que há em cada uma. Com o
-- catálogo no começo, 9 das 10 estavam vazias -- ou seja, um menu de dez
-- promessas em que nove levavam a "Nenhum anúncio encontrado".
--
-- Com a contagem, o grid vira informação: mostra onde existe oferta e ordena
-- pelas categorias mais cheias.
--
-- Precisa ser SECURITY DEFINER porque desde supabase/anon-content-gate.sql a
-- tabela `suppliers` não é mais legível diretamente por `anon`.
--
-- Expor a contagem para visitante é deliberado e coerente com
-- suppliers_public_count: o número total é argumento de cadastro, não algo a
-- esconder. O que continua limitado é QUANTOS anúncios ele consegue abrir.
--
-- Arquivo autocontido. PRECISA SER RODADO MANUALMENTE no SQL Editor.
-- Re-executável.

create or replace function public.suppliers_count_by_category()
 returns table(category text, total integer)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select
    coalesce(s.category, '')::text as category,
    count(*)::int as total
  from public.suppliers s
  where coalesce(s.status, 'active') = 'active'
    and coalesce(s.category, '') <> ''
  group by coalesce(s.category, '');
$function$;

revoke execute on function public.suppliers_count_by_category() from public;
grant execute on function public.suppliers_count_by_category() to anon, authenticated;
