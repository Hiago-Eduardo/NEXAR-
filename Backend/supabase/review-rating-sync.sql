-- ==========================================================================
-- NOTA DO FORNECEDOR -- recálculo no banco, por trigger
--
-- BUG QUE ISTO CORRIGE (encontrado na seção 84, corrigido na seção 97):
-- ReviewForm.jsx gravava a avaliação e, logo depois, chamava
-- `api.entities.Supplier.update()` para reescrever `suppliers.rating` e
-- `suppliers.total_reviews` com a média recalculada. Só que a policy de
-- update em suppliers é "Owners can update suppliers" (auth.uid() =
-- created_by): um CLIENTE avaliando o fornecedor NÃO tem permissão de
-- escrever nessas colunas. O insert da avaliação passava, o update era
-- negado, e a nota do fornecedor ficava congelada em 0 para sempre --
-- exceto no caso absurdo do próprio dono se avaliar.
--
-- POR QUE TRIGGER E NÃO UMA RPC: uma RPC de "recalcular" resolveria o
-- permissionamento, mas continuaria dependendo de o cliente lembrar de
-- chamá-la -- e não cobriria exclusão nem edição de avaliação. O trigger
-- torna impossível a nota divergir das avaliações, venha a escrita de onde
-- vier (tela, RPC, SQL editor, admin). Mesmo padrão dos triggers de
-- enforcement que já existem (enforce_supplier_ad_rules em
-- rls-policies.sql, enforce_product_catalog_rules em product-catalog.sql).
--
-- RE-EXECUTÁVEL DO INÍCIO AO FIM -- VERIFICADO (2026-09-18, seção 99).
-- Tudo é `create or replace`, `drop ... if exists` ou update idempotente.
-- Seguindo a lição da seção 94 ("é re-executável só vale depois de ser
-- executado duas vezes"), o arquivo foi de fato rodado duas vezes contra o
-- banco. A prova de que a segunda passada chegou ao FIM (e não abortou no
-- meio, como acontecia na seção 94) é o bloco 6: ele é a última instrução
-- do arquivo, mudou entre a primeira e a segunda execução, e o estado novo
-- apareceu no banco -- `information_schema.routine_privileges` para
-- recalc_supplier_rating passou a listar só postgres e service_role.
-- ==========================================================================


-- --------------------------------------------------------------------------
-- 1) RECÁLCULO
--
-- security definer porque precisa escrever em suppliers, que tem RLS e cuja
-- policy de update só autoriza o dono. Roda como dono da função (postgres),
-- então passa pela RLS e também pelo revoke de coluna do bloco 4.
--
-- Sem avaliação nenhuma a nota volta a 0, não a null: a tela trata 0 como
-- "sem nota" (`supplier.rating > 0` em SupplierCard.jsx e SupplierProfile.jsx)
-- e null quebraria o `.toFixed(1)`.
-- --------------------------------------------------------------------------
create or replace function public.recalc_supplier_rating(p_supplier_id uuid)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.suppliers s
     set rating = coalesce(
           (select round(avg(r.rating)::numeric, 1)
              from public.reviews r
             where r.supplier_id = p_supplier_id),
           0
         ),
         total_reviews = (
           select count(*)
             from public.reviews r
            where r.supplier_id = p_supplier_id
         )
   where s.id = p_supplier_id;
$function$;


-- --------------------------------------------------------------------------
-- 2) TRIGGER DE SINCRONIA
--
-- Cobre insert, update e delete. O caso de um update que MOVE a avaliação de
-- um anúncio para outro recalcula os dois lados -- hoje nenhuma tela faz
-- isso, mas é o tipo de buraco que só aparece anos depois.
-- --------------------------------------------------------------------------
create or replace function public.reviews_sync_supplier_rating()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recalc_supplier_rating(old.supplier_id);
    return old;
  end if;

  if tg_op = 'UPDATE' and new.supplier_id is distinct from old.supplier_id then
    perform public.recalc_supplier_rating(old.supplier_id);
  end if;

  perform public.recalc_supplier_rating(new.supplier_id);
  return new;
end;
$function$;

drop trigger if exists reviews_sync_supplier_rating on public.reviews;

create trigger reviews_sync_supplier_rating
after insert or update or delete on public.reviews
for each row execute function public.reviews_sync_supplier_rating();


-- --------------------------------------------------------------------------
-- 3) BACKFILL
--
-- Todas as notas gravadas até hoje estão erradas (congeladas no valor que
-- tinham quando o anúncio foi criado, normalmente 0), porque o update do
-- cliente nunca passou. Recalcula a tabela inteira uma vez.
--
-- Roda em TODOS os anúncios, não só nos que têm avaliação: um anúncio com
-- nota gravada e zero avaliações precisa voltar para 0.
-- --------------------------------------------------------------------------
update public.suppliers s
   set rating = coalesce(agg.avg_rating, 0),
       total_reviews = coalesce(agg.n, 0)
  from (
    select s2.id,
           (select round(avg(r.rating)::numeric, 1)
              from public.reviews r where r.supplier_id = s2.id) as avg_rating,
           (select count(*)
              from public.reviews r where r.supplier_id = s2.id) as n
      from public.suppliers s2
  ) agg
 where agg.id = s.id
   and (s.rating is distinct from coalesce(agg.avg_rating, 0)
     or s.total_reviews is distinct from coalesce(agg.n, 0)::integer);


-- --------------------------------------------------------------------------
-- 4) A NOTA DEIXA DE SER ESCRITÍVEL PELO CLIENTE
--
-- Com o bloco 1 no lugar, `suppliers.rating`/`total_reviews` passam a ser
-- colunas DERIVADAS -- mas a policy "Owners can update suppliers" ainda
-- deixaria o próprio fornecedor mandar um PATCH direto na API e escrever
-- rating = 5.0 sem nenhuma avaliação. Num produto cujo valor é confiança,
-- isso não pode depender de o frontend ter boas maneiras.
--
-- ARMADILHA JÁ CONHECIDA (seção do contact-info-login-gate.sql): revoke por
-- COLUNA é NO-OP quando a role já tem o privilégio na TABELA inteira -- foi
-- exatamente isso que fez a primeira versão daquele arquivo não funcionar.
-- Por isso aqui também: revoga a tabela e concede de volta coluna a coluna.
--
-- A lista de colunas é montada do information_schema em vez de digitada:
-- esquecer uma coluna aqui deixaria ela sem update e quebraria o AdEditor
-- em silêncio. O efeito colateral é que este bloco precisa ser RE-RODADO
-- sempre que uma coluna nova for adicionada em suppliers.
--
-- Conferido antes de escrever isto: nenhuma tela manda rating/total_reviews
-- num update. AdEditor.jsx envia uma lista fixa de 13 campos que não os
-- inclui, e Dashboard.jsx só manda { status }.
--
-- >>> Se preferir não travar a escrita agora, este bloco 4 pode ser
-- >>> removido sem afetar os blocos 1 a 3 (a correção do bug em si).
-- --------------------------------------------------------------------------
do $$
declare
  writable_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into writable_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'suppliers'
     and column_name not in ('rating', 'total_reviews');

  if writable_cols is null then
    raise exception 'Tabela public.suppliers não encontrada';
  end if;

  execute 'revoke update on public.suppliers from authenticated';
  execute format('grant update (%s) on public.suppliers to authenticated', writable_cols);
end
$$;


-- --------------------------------------------------------------------------
-- 5) FORNECEDOR NÃO AVALIA O PRÓPRIO ANÚNCIO
--
-- Achado de passagem na mesma revisão. Não era explorável de propósito antes
-- porque a nota nunca subia de todo jeito -- com o bloco 1 funcionando, o
-- dono de um anúncio passaria a conseguir se dar 5 estrelas pela tela normal,
-- quantas vezes quisesse. Bloqueia no insert, com mensagem que o frontend
-- mostra.
--
-- Se qualquer um dos dois created_by for null (dado legado), deixa passar --
-- um guard novo não deve derrubar escrita que já funcionava.
--
-- NÃO RESOLVE avaliação repetida do mesmo cliente no mesmo anúncio: isso é
-- decisão de produto (bloquear? substituir a anterior? deixar editar?) e está
-- anotada em aberto na seção 97 do Resumo.md.
-- --------------------------------------------------------------------------
create or replace function public.enforce_review_rules()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  ad_owner uuid;
begin
  select s.created_by into ad_owner
    from public.suppliers s
   where s.id = new.supplier_id;

  if ad_owner is not null
     and new.created_by is not null
     and ad_owner = new.created_by then
    raise exception 'SELF_REVIEW_NOT_ALLOWED'
      using hint = 'Você não pode avaliar o seu próprio anúncio.';
  end if;

  return new;
end;
$function$;

drop trigger if exists enforce_review_rules on public.reviews;

create trigger enforce_review_rules
before insert on public.reviews
for each row execute function public.enforce_review_rules();


-- --------------------------------------------------------------------------
-- 6) GRANTS
--
-- recalc_supplier_rating é chamada pelos triggers (que rodam como dono), não
-- pelo cliente -- então ninguém precisa de execute nela. Sem isto ela fica
-- sendo um caminho de ESCRITA em suppliers (security definer) aberto a
-- qualquer visitante com a chave publishable.
--
-- CORREÇÃO (2026-09-18, a primeira versão não funcionou): revogar só de
-- `public` é NO-OP no Supabase. O projeto tem
--   alter default privileges in schema public grant execute on functions
--   to anon, authenticated, service_role
-- então toda função nova nasce com grant DIRETO para anon e authenticated --
-- tirar o de PUBLIC não encosta nesses. Testado na API depois de rodar a
-- primeira versão: a chamada como anon voltou HTTP 204 (executou), enquanto
-- uma função de fato revogada (company_public_profile) volta 401/42501.
-- Mesma família de erro do revoke por coluna em contact-info-login-gate.sql
-- e do `create policy` sem drop da seção 94: o comando parece certo, mas um
-- privilégio mais amplo em outro lugar o torna inócuo.
--
-- O padrão correto já existia no próprio repositório -- anon-content-gate.sql
-- linha 308 usa `from public, anon`. Aqui vai também `authenticated`, porque
-- nem o usuário logado tem motivo para chamar um helper de trigger.
-- --------------------------------------------------------------------------
revoke execute on function public.recalc_supplier_rating(uuid)
  from public, anon, authenticated;

-- Avisa o PostgREST para recarregar o cache de schema -- funções novas e
-- mudança de grants. Idempotente e inofensivo se já estiver em dia.
notify pgrst, 'reload schema';
