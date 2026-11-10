-- ==========================================================================
-- LIMITES DE PLANO -- ETAPA 2: ENDURECIMENTO (lado da ESCRITA)
--
-- Fecha os caminhos pelos quais o próprio fornecedor, chamando a API direto
-- (a chave publishable está no bundle do site), consegue passar por cima das
-- regras de plano. Resumo.md seções 179 (achados) e 182 (esta etapa).
--
-- O QUE ENTRA
--   1. Colunas de SISTEMA viram somente-leitura para o cliente:
--        suppliers: status_before_suspension, suspended_at, suspension_reason,
--                   verified, featured  -> recusa com erro
--        suppliers.plan                 -> o banco SOBRESCREVE com o plano real
--                                          (sem erro: o AdEditor manda `plan`
--                                          em todo salvamento e não pode quebrar)
--        products:  suspended_at, suspension_reason -> recusa com erro
--   2. Status 'suspended' é exclusivo do sistema, em anúncio E produto: o
--      cliente não entra nem sai dele. Pausar/ativar continua livre (com o
--      limite de sempre na ativação do anúncio).
--   3. Contagem dos limites à prova de CHAMADAS SIMULTÂNEAS (anúncios,
--      produtos, fotos de produto, fotos do anúncio): trava por conta
--      (pg_advisory_xact_lock) antes de contar. Sem ela, duas requisições
--      paralelas -- cada uma na sua transação -- não enxergam a linha uma da
--      outra, leem a mesma contagem e as duas passam.
--      (Escrita em LOTE dentro de UM comando -- POST com array, PATCH com
--      filtro -- JÁ era barrada: o trigger é plpgsql e cada comando dele tira
--      snapshot novo. A auditoria da seção 179 dizia o contrário; o ensaio
--      desta etapa provou que estava errada. Ver seção 182.)
--   4. Foto não muda de dono: o cliente não pode trocar
--      supplier_images.supplier_id / product_images.product_id num UPDATE
--      (furava o limite por anúncio levando fotos de um para outro).
--   5. fornecedor_has_active_plan passa a usar a mesma definição de "plano
--      vigente" que o resto (fornecedor_current_plan_id) -- antes uma linha
--      'scheduled' contava como plano ativo.
--
-- QUEM É "CLIENTE": current_user em ('authenticated', 'anon') e sem papel de
-- admin no JWT. As funções do sistema (suspend_my_ads, restore_my_suspended_
-- ads, sync_supplier_plan_from_subscription, sync_supplier_cover,
-- recalc_supplier_rating...) são SECURITY DEFINER de `postgres`: dentro
-- delas current_user é o dono da função, então passam livres -- exatamente
-- como antes. O cliente não tem como mudar current_user pela API.
--
-- O QUE NÃO MUDA
--   * Nenhuma leitura, policy, RPC pública, função de assinatura
--     (subscribe/sync/cancel/reactivate), suspend_my_ads ou
--     restore_my_suspended_ads.
--   * Nenhum dado (autoverificado: contagem + hash antes/depois).
--   * enforce_supplier_ad_rules NÃO é tocado: a restauração pelo sistema
--     continua passando por ele exatamente como hoje. (Hoje, restaurar mais
--     anúncios do que o plano comporta estoura PLAN_LIMIT e derruba o
--     subscribe/sync/reactivate que chamou -- bug pré-existente, seção 182,
--     a ser resolvido pela função central da próxima etapa.)
--   * Telas: nenhuma manda as colunas protegidas. AdEditor manda `plan`
--     (agora sobrescrito pelo banco com o mesmo valor que ele já mandava),
--     Dashboard manda só { status } entre active/paused.
--
-- SUBSTITUI (ordem importa -- re-rodar o arquivo antigo depois DESFAZ isto):
--   fornecedor_has_active_plan  (de rls-policies.sql)
--   fornecedor_active_ad_count  (de rls-policies.sql)
--   fornecedor_product_count    (de product-catalog.sql)
--   product_image_count         (de product-catalog.sql)
--   supplier_image_count        (de supplier-gallery.sql)
-- Roda DEPOIS de plan-limits-structure.sql.
--
-- RE-EXECUTÁVEL. PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- O resultado final (última consulta) traz antes/depois e os testes.
-- ==========================================================================

drop table if exists _plh_relatorio;
drop table if exists _plh_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES (mesma técnica de plan-limits-structure.sql)
-- --------------------------------------------------------------------------
create temp table _plh_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.suppliers)       as suppliers,
  (select count(*) from public.products)        as products,
  (select count(*) from public.product_images)  as product_images,
  (select count(*) from public.supplier_images) as supplier_images,
  (select count(*) from public.subscriptions)   as subscriptions,
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s) as hash_suppliers,
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p) as hash_products,
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i) as hash_product_images,
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g) as hash_supplier_images,
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b) as hash_subscriptions;


-- --------------------------------------------------------------------------
-- 1) QUEM ESTÁ ESCREVENDO
-- --------------------------------------------------------------------------
create or replace function public.is_client_writer()
 returns boolean
 language sql
 stable
as $function$
  select current_user in ('authenticated', 'anon')
     and coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin';
$function$;

comment on function public.is_client_writer() is
  'true quando a escrita vem do cliente (PostgREST como authenticated/anon, sem admin). Funcoes security definer do sistema rodam como o dono e dao false.';


-- --------------------------------------------------------------------------
-- 2) CONTAGENS: VOLATILE + TRAVA POR CONTA
--
-- A trava é transacional (solta no commit/rollback) e por chave de conta (ou
-- de anúncio/produto, no caso das fotos). Ela fica DENTRO da contagem porque
-- é a contagem que precisa ser serializada, e assim os triggers que já
-- chamam estas funções ficam corretos sem precisar ser reescritos.
--
-- Mesma assinatura, mesmo retorno, mesmo corpo de consulta das versões
-- anteriores -- entra a trava. Precisa ser plpgsql VOLATILE: cada comando
-- dela tira snapshot novo, então a contagem acontece DEPOIS de obter a trava
-- e enxerga o que a outra requisição gravou e commitou. Uma função SQL
-- STABLE usaria o snapshot do comando que a chamou -- tirado ANTES de
-- esperar a trava -- e a trava não adiantaria nada.
-- --------------------------------------------------------------------------
create or replace function public.fornecedor_active_ad_count(p_uid uuid)
 returns integer
 language plpgsql
 volatile
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('nexar:ads:' || p_uid::text, 0));
  return (select count(*)::int from public.suppliers s
          where s.created_by = p_uid and s.status = 'active');
end;
$function$;

create or replace function public.fornecedor_product_count(p_uid uuid)
 returns integer
 language plpgsql
 volatile
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('nexar:products:' || p_uid::text, 0));
  return (select count(*)::int from public.products p where p.created_by = p_uid);
end;
$function$;

create or replace function public.product_image_count(p_product_id uuid)
 returns integer
 language plpgsql
 volatile
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('nexar:product_images:' || p_product_id::text, 0));
  return (select count(*)::int from public.product_images pi where pi.product_id = p_product_id);
end;
$function$;

create or replace function public.supplier_image_count(p_supplier_id uuid)
 returns integer
 language plpgsql
 volatile
as $function$
begin
  perform pg_advisory_xact_lock(hashtextextended('nexar:supplier_images:' || p_supplier_id::text, 0));
  return (select count(*)::int from public.supplier_images where supplier_id = p_supplier_id);
end;
$function$;

-- "Tem plano vigente?" -- a mesma definição usada para o LIMITE. A versão de
-- rls-policies.sql olhava só expires_at > now(), sem status: uma linha
-- 'scheduled' (downgrade agendado) contava como plano ativo.
create or replace function public.fornecedor_has_active_plan(p_uid uuid)
 returns boolean
 language sql
 stable
as $function$
  select public.fornecedor_current_plan_id(p_uid) is not null;
$function$;


-- --------------------------------------------------------------------------
-- 4) GUARDA DAS COLUNAS DE SISTEMA -- suppliers
-- --------------------------------------------------------------------------
create or replace function public.guard_supplier_system_columns()
 returns trigger
 language plpgsql
as $function$
declare
  v_plan text;
begin
  if not public.is_client_writer() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if new.status = 'suspended' then
      raise exception 'SYSTEM_STATUS: apenas o sistema suspende anuncios.';
    end if;
    if new.status_before_suspension is not null
       or new.suspended_at is not null
       or new.suspension_reason is not null then
      raise exception 'PROTECTED_COLUMN: campos de suspensao sao controlados pelo sistema.';
    end if;
    if coalesce(new.verified, false) or coalesce(new.featured, false) then
      raise exception 'PROTECTED_COLUMN: verified/featured sao controlados pelo sistema.';
    end if;
  else
    if old.status = 'suspended' and new.status is distinct from 'suspended' then
      raise exception 'AD_SUSPENDED: anuncio suspenso pelo sistema; ele volta quando o plano permitir.';
    end if;
    if new.status = 'suspended' and old.status is distinct from 'suspended' then
      raise exception 'SYSTEM_STATUS: apenas o sistema suspende anuncios.';
    end if;
    if new.status_before_suspension is distinct from old.status_before_suspension
       or new.suspended_at is distinct from old.suspended_at
       or new.suspension_reason is distinct from old.suspension_reason then
      raise exception 'PROTECTED_COLUMN: campos de suspensao sao controlados pelo sistema.';
    end if;
    if new.verified is distinct from old.verified
       or new.featured is distinct from old.featured then
      raise exception 'PROTECTED_COLUMN: verified/featured sao controlados pelo sistema.';
    end if;
  end if;

  -- plan: cópia do plano REAL da conta. Sobrescreve em vez de recusar
  -- porque o AdEditor manda `plan` em todo salvamento. Sem plano vigente,
  -- mantém o anterior (no INSERT: o que veio -- o anúncio não pode ficar
  -- ativo sem plano, e trg_sync_supplier_plan corrige na próxima assinatura).
  v_plan := public.fornecedor_current_plan_id(new.created_by);
  if v_plan is not null then
    new.plan := v_plan;
  elsif TG_OP = 'UPDATE' then
    new.plan := old.plan;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_supplier_system_columns on public.suppliers;
create trigger trg_guard_supplier_system_columns
before insert or update on public.suppliers
for each row execute function public.guard_supplier_system_columns();


-- --------------------------------------------------------------------------
-- 5) GUARDA DAS COLUNAS DE SISTEMA -- products
--
-- Pausar/ativar (active <-> paused) fica livre: é o fornecedor decidindo. O
-- limite de produtos ATIVOS na ativação é da próxima etapa -- hoje o limite
-- ainda conta todos os produtos, ativos ou não, então ativar não muda nada.
-- --------------------------------------------------------------------------
create or replace function public.guard_product_system_columns()
 returns trigger
 language plpgsql
as $function$
begin
  if not public.is_client_writer() then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    if new.status = 'suspended' then
      raise exception 'SYSTEM_STATUS: apenas o sistema suspende produtos.';
    end if;
    if new.suspended_at is not null or new.suspension_reason is not null then
      raise exception 'PROTECTED_COLUMN: campos de suspensao sao controlados pelo sistema.';
    end if;
  else
    if old.status = 'suspended' and new.status is distinct from 'suspended' then
      raise exception 'PRODUCT_SUSPENDED: produto suspenso pelo sistema; ele volta quando o plano permitir.';
    end if;
    if new.status = 'suspended' and old.status is distinct from 'suspended' then
      raise exception 'SYSTEM_STATUS: apenas o sistema suspende produtos.';
    end if;
    if new.suspended_at is distinct from old.suspended_at
       or new.suspension_reason is distinct from old.suspension_reason then
      raise exception 'PROTECTED_COLUMN: campos de suspensao sao controlados pelo sistema.';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_guard_product_system_columns on public.products;
create trigger trg_guard_product_system_columns
before insert or update on public.products
for each row execute function public.guard_product_system_columns();


-- --------------------------------------------------------------------------
-- 6) FOTO NÃO MUDA DE DONO
--
-- supplier_images tem policy de UPDATE (reordenar) que aceita qualquer
-- supplier_id do mesmo dono -- levar fotos de um anúncio para outro furava o
-- limite por anúncio, que só é checado no INSERT. product_images não tem
-- policy de UPDATE hoje; a guarda fica pronta para quando tiver.
-- --------------------------------------------------------------------------
-- UMA FUNÇÃO POR TABELA, de propósito: plpgsql resolve `new.<coluna>` em
-- tempo de execução, e uma função única que citasse new.product_id quebrava
-- o UPDATE de supplier_images ("record new has no field product_id") --
-- pego no ensaio local, teria quebrado a reordenação da galeria no AdEditor.
create or replace function public.guard_supplier_image_parent()
 returns trigger
 language plpgsql
as $function$
begin
  if public.is_client_writer() and new.supplier_id is distinct from old.supplier_id then
    raise exception 'PROTECTED_COLUMN: a foto nao pode ser movida para outro anuncio.';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_product_image_parent()
 returns trigger
 language plpgsql
as $function$
begin
  if public.is_client_writer() and new.product_id is distinct from old.product_id then
    raise exception 'PROTECTED_COLUMN: a foto nao pode ser movida para outro produto.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_supplier_image_parent on public.supplier_images;
drop trigger if exists trg_guard_product_image_parent on public.product_images;

create trigger trg_guard_supplier_image_parent
before update on public.supplier_images
for each row execute function public.guard_supplier_image_parent();

create trigger trg_guard_product_image_parent
before update on public.product_images
for each row execute function public.guard_product_image_parent();


-- --------------------------------------------------------------------------
-- 7) GRANTS -- funções de trigger e helpers não são endpoints.
--
-- `from public, anon, authenticated` e não só `from public`: o projeto tem
-- default privileges que dão EXECUTE direto para anon/authenticated (lição
-- de review-rating-sync.sql, seção 98).
--
-- Só as funções DE TRIGGER são revogadas. As que os triggers chamam por
-- dentro (contagens, is_client_writer, plan_*) NÃO podem ser: a função de
-- trigger roda com os privilégios de quem disparou a escrita, então
-- authenticated precisa de EXECUTE nelas -- e já tem, pelo default.
-- --------------------------------------------------------------------------
revoke execute on function public.guard_supplier_system_columns() from public, anon, authenticated;
revoke execute on function public.guard_product_system_columns() from public, anon, authenticated;
revoke execute on function public.guard_supplier_image_parent() from public, anon, authenticated;
revoke execute on function public.guard_product_image_parent() from public, anon, authenticated;


-- --------------------------------------------------------------------------
-- 8) FOTOGRAFIA DEPOIS + COMPARAÇÃO -- qualquer diferença aborta tudo.
-- --------------------------------------------------------------------------
insert into _plh_foto
select
  'depois',
  (select count(*) from public.suppliers),
  (select count(*) from public.products),
  (select count(*) from public.product_images),
  (select count(*) from public.supplier_images),
  (select count(*) from public.subscriptions),
  (select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s),
  (select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p),
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i),
  (select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g),
  (select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b);

do $confere$
declare
  a _plh_foto;
  d _plh_foto;
begin
  select * into a from _plh_foto where momento = 'antes';
  select * into d from _plh_foto where momento = 'depois';
  if (a.suppliers, a.products, a.product_images, a.supplier_images, a.subscriptions,
      a.hash_suppliers, a.hash_products, a.hash_product_images, a.hash_supplier_images, a.hash_subscriptions)
     is distinct from
     (d.suppliers, d.products, d.product_images, d.supplier_images, d.subscriptions,
      d.hash_suppliers, d.hash_products, d.hash_product_images, d.hash_supplier_images, d.hash_subscriptions)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%', to_jsonb(a), to_jsonb(d);
  end if;
end
$confere$;

create temp table _plh_relatorio as select * from _plh_foto;

commit;

notify pgrst, 'reload schema';


-- ==========================================================================
-- 9) TESTES DE COMPORTAMENTO -- NADA FICA GRAVADO
--
-- Cada teste roda num sub-bloco que SEMPRE termina em exceção: o Postgres
-- desfaz tudo o que o sub-bloco fez (escritas, `set role`, claims do JWT).
-- O teste se faz passar pelo fornecedor real (role authenticated + JWT com
-- o uid dele), exatamente como a API faria.
--
-- Contas usadas (escolhidas sozinhas, pelos dados):
--   P = dono com mais anúncios ativos e plano vigente
--   B = conta com plano vigente 'basico' e 0 produtos (para o teste de lote)
-- ==========================================================================

create temp table _plh_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  v_p uuid;
  v_b uuid;
  v_ad uuid;
  v_ad2 uuid;
  v_prod uuid;
  v_img uuid;
  v_res text;
begin
  select s.created_by into v_p
  from public.suppliers s
  where s.status = 'active' and public.fornecedor_current_plan_id(s.created_by) is not null
  group by s.created_by order by count(*) desc limit 1;

  select x.uid into v_b
  from (select distinct created_by as uid from public.suppliers) x
  where public.fornecedor_current_plan_id(x.uid) = 'basico'
    and not exists (select 1 from public.products p where p.created_by = x.uid)
  limit 1;

  if v_p is null then
    insert into _plh_testes values ('conta P encontrada', 'sim', 'NAO -- testes de P pulados', false);
  else
    select id into v_ad from public.suppliers where created_by = v_p and status = 'active' order by created_at limit 1;
    select id into v_ad2 from public.suppliers where created_by = v_p and status = 'active' and id <> v_ad order by created_at limit 1;
    select id into v_prod from public.products where created_by = v_p order by created_at limit 1;
    select id into v_img from public.supplier_images where supplier_id = v_ad limit 1;

    -- Esqueleto de todo teste: claims + role do fornecedor, a escrita, e um
    -- `raise 'FIM:<resultado>'` que desfaz tudo e entrega o resultado.
    -- T1 plan forjado é sobrescrito
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set plan = 'xyz_forjado' where id = v_ad;
      select 'OK:' || plan into v_res from public.suppliers where id = v_ad;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente grava plan=xyz_forjado', 'OK:<plano real>', v_res,
      v_res = 'OK:' || public.fornecedor_current_plan_id(v_p));

    -- T2 suspender por conta própria
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set status = 'suspended' where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente põe status=suspended', 'SYSTEM_STATUS', left(v_res, 60), v_res like 'SYSTEM_STATUS%');

    -- T3 colunas de suspensão
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set status_before_suspension = 'active' where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente grava status_before_suspension', 'recusado', left(v_res, 60), v_res not like 'OK%');

    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set suspension_reason = 'plan_limit' where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente grava suspension_reason', 'recusado', left(v_res, 60), v_res not like 'OK%');

    -- T4 verified/featured
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set verified = true where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente grava verified=true', 'PROTECTED_COLUMN', left(v_res, 60), v_res like 'PROTECTED_COLUMN%');

    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set featured = true where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente grava featured=true', 'PROTECTED_COLUMN', left(v_res, 60), v_res like 'PROTECTED_COLUMN%');

    -- T5 o fluxo normal continua: pausar e reativar, salvar como o AdEditor
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set status = 'paused' where id = v_ad;
      update public.suppliers set status = 'active' where id = v_ad;
      update public.suppliers set description = description, plan = plan where id = v_ad;
      select 'OK:' || status into v_res from public.suppliers where id = v_ad;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: pausar, reativar e salvar (fluxo normal)', 'OK:active', left(v_res, 60), v_res = 'OK:active');

    -- T6 o sistema continua podendo suspender (como suspend_my_ads faz)
    begin
      update public.suppliers set status = 'suspended', status_before_suspension = 'active',
                                  suspended_at = now(), suspension_reason = 'no_plan' where id = v_ad;
      select 'OK:' || status into v_res from public.suppliers where id = v_ad;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: SISTEMA suspende', 'OK:suspended', left(v_res, 60), v_res = 'OK:suspended');

    -- T7 cliente não tira da suspensão
    begin
      update public.suppliers set status = 'suspended', status_before_suspension = 'active' where id = v_ad;
      perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      update public.suppliers set status = 'active' where id = v_ad;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('anúncio: cliente reativa um suspenso', 'AD_SUSPENDED', left(v_res, 60), v_res like 'AD_SUSPENDED%');

    -- T8 foto do anúncio não muda de anúncio
    if v_img is not null and v_ad2 is not null then
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.supplier_images set supplier_id = v_ad2 where id = v_img;
        raise exception 'FIM:OK';
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('galeria: cliente move foto para outro anúncio', 'PROTECTED_COLUMN', left(v_res, 60), v_res like 'PROTECTED_COLUMN%');

      begin
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.supplier_images set position = position where id = v_img;
        raise exception 'FIM:OK';
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('galeria: cliente reordena (fluxo normal)', 'OK', left(v_res, 60), v_res = 'OK');
    else
      insert into _plh_testes values ('galeria: testes', 'conta P com foto e 2 anúncios', 'pulado', null);
    end if;

    -- T9 produto
    if v_prod is not null then
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.products set status = 'suspended' where id = v_prod;
        raise exception 'FIM:OK';
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('produto: cliente põe status=suspended', 'SYSTEM_STATUS', left(v_res, 60), v_res like 'SYSTEM_STATUS%');

      begin
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.products set suspension_reason = 'no_plan' where id = v_prod;
        raise exception 'FIM:OK';
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('produto: cliente grava suspension_reason', 'PROTECTED_COLUMN', left(v_res, 60), v_res like 'PROTECTED_COLUMN%');

      begin
        update public.products set status = 'suspended', suspension_reason = 'plan_limit', suspended_at = now() where id = v_prod;
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.products set status = 'active' where id = v_prod;
        raise exception 'FIM:OK';
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('produto: cliente reativa um suspenso', 'PRODUCT_SUSPENDED', left(v_res, 60), v_res like 'PRODUCT_SUSPENDED%');

      begin
        perform set_config('request.jwt.claims', json_build_object('sub', v_p, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        update public.products set status = 'paused' where id = v_prod;
        update public.products set status = 'active', name = name where id = v_prod;
        select 'OK:' || status into v_res from public.products where id = v_prod;
        raise exception 'FIM:%', v_res;
      exception when others then v_res := replace(sqlerrm, 'FIM:', '');
      end;
      insert into _plh_testes values ('produto: pausar, reativar e salvar (fluxo normal)', 'OK:active', left(v_res, 60), v_res = 'OK:active');
    else
      insert into _plh_testes values ('produto: testes', 'conta P com produto', 'pulado', null);
    end if;
  end if;

  -- T10 LOTE: 6 produtos num único INSERT numa conta Básico vazia (limite 5).
  -- Com a contagem antiga (STABLE) os 6 passavam.
  if v_b is null then
    insert into _plh_testes values ('lote: conta Básico sem produtos', 'encontrada', 'nenhuma -- teste pulado', null);
  else
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      insert into public.products (name, created_by)
      select 'teste-lote-' || g, v_b from generate_series(1, 6) g;
      raise exception 'FIM:OK';
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('lote: Básico cria 6 produtos num só INSERT', 'PLAN_LIMIT', left(v_res, 60), v_res like 'PLAN_LIMIT%');

    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      insert into public.products (name, created_by)
      select 'teste-lote-' || g, v_b from generate_series(1, 5) g;
      select 'OK:' || count(*) into v_res from public.products where created_by = v_b;
      raise exception 'FIM:%', v_res;
    exception when others then v_res := replace(sqlerrm, 'FIM:', '');
    end;
    insert into _plh_testes values ('lote: Básico cria 5 produtos (no limite)', 'OK:5', left(v_res, 60), v_res = 'OK:5');
  end if;

  -- Nenhum teste deixou rastro.
  insert into _plh_testes
  select 'produtos "teste-lote" no banco', '0', count(*)::text, count(*) = 0
  from public.products where name like 'teste-lote-%';
end
$testes$;


-- ==========================================================================
-- 10) RESULTADO
-- ==========================================================================

select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s',
              suppliers, products, product_images, supplier_images, subscriptions) as esperado,
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left(hash_suppliers, 8), left(hash_products, 8), left(hash_product_images, 8),
              left(hash_supplier_images, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _plh_relatorio
union all
select teste, esperado, obtido, ok from _plh_testes
union all
select 'contagem agora (pós-testes)',
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s',
              (select count(*) from public.suppliers), (select count(*) from public.products),
              (select count(*) from public.product_images), (select count(*) from public.supplier_images),
              (select count(*) from public.subscriptions)),
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left((select md5(coalesce(string_agg(to_jsonb(s)::text, '|' order by s.id), '')) from public.suppliers s), 8),
              left((select md5(coalesce(string_agg(to_jsonb(p)::text, '|' order by p.id), '')) from public.products p), 8),
              left((select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), '')) from public.product_images i), 8),
              left((select md5(coalesce(string_agg(to_jsonb(g)::text, '|' order by g.id), '')) from public.supplier_images g), 8),
              left((select md5(coalesce(string_agg(to_jsonb(b)::text, '|' order by b.id), '')) from public.subscriptions b), 8)),
       null;
