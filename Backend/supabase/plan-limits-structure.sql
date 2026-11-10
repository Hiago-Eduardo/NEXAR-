-- ==========================================================================
-- LIMITES DE PLANO -- ETAPA 1: SÓ ESTRUTURA
--
-- Prepara o banco para a nova lógica de limites (Resumo.md seções 179-180)
-- SEM MUDAR NENHUM COMPORTAMENTO. Nenhuma função, trigger, policy ou grant é
-- criado ou alterado aqui. Nenhum anúncio, produto, foto ou assinatura muda.
--
-- O QUE ENTRA:
--   suppliers.suspension_reason   NULL | 'plan_limit' | 'no_plan'
--   products.status               'active' | 'paused' | 'suspended'  (NOT NULL, default 'active')
--   products.suspended_at         timestamptz
--   products.suspension_reason    NULL | 'plan_limit' | 'no_plan'
--
-- POR QUE ISSO NÃO MUDA NADA HOJE:
--   * Todo produto existente nasce 'active' (o default preenche as linhas
--     existentes no próprio ADD COLUMN). Nenhuma leitura, policy, RPC ou
--     trigger olha products.status ainda -- o limite continua contando todos
--     os produtos, o catálogo público continua mostrando todos.
--   * Produto novo criado pelo Catálogo não manda `status` -> recebe 'active'.
--   * suspension_reason fica NULL em tudo. suspend_my_ads/restore_my_suspended_
--     ads NÃO foram alterados e não escrevem nessa coluna (próxima etapa).
--   * Nenhuma tela manda essas colunas: AdEditor e Catálogo montam o payload
--     campo a campo, Dashboard manda só { status }.
--
-- ORDEM: arquivo novo, roda DEPOIS de todos os existentes (último aplicado:
-- chat-by-account.sql, seção 167). Não substitui nenhuma função, então re-rodar
-- arquivos anteriores não o desfaz -- e ele não desfaz nenhum deles.
--
-- RE-EXECUTÁVEL: ADD COLUMN IF NOT EXISTS, constraints criadas só se não
-- existirem, update guardado por `where status is null`.
--
-- AUTOVERIFICAÇÃO: tudo roda numa transação. Antes de alterar, tira uma
-- fotografia (contagem + hash) de suppliers, products, product_images,
-- supplier_images e subscriptions. Depois de alterar, compara. Se QUALQUER
-- coisa tiver mudado, levanta exceção e a transação inteira volta atrás --
-- nada fica aplicado. O resultado final (última consulta) mostra antes/depois
-- e os testes de estrutura.
--
-- PRECISA SER RODADO MANUALMENTE no SQL Editor do Supabase.
-- ==========================================================================

-- Sobras de uma execução anterior na mesma sessão do editor.
drop table if exists _plm_relatorio;
drop table if exists _plm_testes;

begin;

-- --------------------------------------------------------------------------
-- 0) FOTOGRAFIA ANTES
--
-- to_jsonb(linha) - 'coluna_nova': o hash ignora só as colunas que este
-- arquivo cria, então "antes" e "depois" comparam exatamente os mesmos dados
-- -- inclusive na 2ª execução, quando as colunas já existem.
-- --------------------------------------------------------------------------
create temp table _plm_foto on commit drop as
select
  'antes'::text as momento,
  (select count(*) from public.suppliers)       as suppliers,
  (select count(*) from public.products)        as products,
  (select count(*) from public.product_images)  as product_images,
  (select count(*) from public.supplier_images) as supplier_images,
  (select count(*) from public.subscriptions)   as subscriptions,
  (select md5(coalesce(string_agg((to_jsonb(s) - 'suspension_reason')::text, '|' order by s.id), ''))
     from public.suppliers s) as hash_suppliers,
  (select md5(coalesce(string_agg((to_jsonb(p) - 'status' - 'suspended_at' - 'suspension_reason')::text, '|' order by p.id), ''))
     from public.products p) as hash_products,
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), ''))
     from public.product_images i) as hash_product_images,
  (select md5(coalesce(string_agg(to_jsonb(si)::text, '|' order by si.id), ''))
     from public.supplier_images si) as hash_supplier_images,
  (select md5(coalesce(string_agg(to_jsonb(sub)::text, '|' order by sub.id), ''))
     from public.subscriptions sub) as hash_subscriptions,
  (select jsonb_object_agg(st, n) from (
     select coalesce(status, 'null') as st, count(*) as n
     from public.suppliers group by 1) x) as suppliers_por_status;


-- --------------------------------------------------------------------------
-- 1) suppliers.suspension_reason
--
-- Só o MOTIVO. status / status_before_suspension / suspended_at continuam
-- como estão (billing-cycle-day-10.sql). NULL = não suspenso, ou suspenso
-- antes desta coluna existir (ver "riscos" no Resumo).
-- --------------------------------------------------------------------------
alter table public.suppliers
  add column if not exists suspension_reason text;

comment on column public.suppliers.suspension_reason is
  'Motivo da suspensao: plan_limit (plano nao comporta) ou no_plan (sem plano/pagamento). NULL quando nao suspenso.';

do $sup_reason$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and conname = 'suppliers_suspension_reason_check'
  ) then
    alter table public.suppliers
      add constraint suppliers_suspension_reason_check
      check (suspension_reason is null or suspension_reason in ('plan_limit', 'no_plan'));
  end if;
end
$sup_reason$;


-- --------------------------------------------------------------------------
-- 2) products.status / suspended_at / suspension_reason
--
-- Sequência pedida: cria a coluna -> garante 'active' em todo produto
-- existente -> só então NOT NULL e CHECK.
--
-- ADD COLUMN ... DEFAULT 'active' já grava 'active' nas linhas existentes
-- (Postgres 11+, sem reescrever a tabela e sem disparar trigger). O UPDATE
-- seguinte é a rede de segurança para o caso de a coluna já existir sem
-- default por algum motivo: em condições normais afeta 0 linhas.
-- --------------------------------------------------------------------------
alter table public.products
  add column if not exists status text default 'active';

alter table public.products
  alter column status set default 'active';

update public.products
set status = 'active'
where status is null;

alter table public.products
  alter column status set not null;

alter table public.products
  add column if not exists suspended_at timestamptz;

alter table public.products
  add column if not exists suspension_reason text;

comment on column public.products.status is
  'active = publicado e conta no limite; paused = pausado pelo dono; suspended = suspenso pelo sistema por causa do plano.';
comment on column public.products.suspension_reason is
  'Motivo da suspensao: plan_limit ou no_plan. NULL quando nao suspenso.';

do $prod_checks$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_status_check'
  ) then
    alter table public.products
      add constraint products_status_check
      check (status in ('active', 'paused', 'suspended'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass
      and conname = 'products_suspension_reason_check'
  ) then
    alter table public.products
      add constraint products_suspension_reason_check
      check (suspension_reason is null or suspension_reason in ('plan_limit', 'no_plan'));
  end if;
end
$prod_checks$;


-- --------------------------------------------------------------------------
-- 3) FOTOGRAFIA DEPOIS + COMPARAÇÃO. Qualquer diferença aborta tudo.
-- --------------------------------------------------------------------------
insert into _plm_foto
select
  'depois',
  (select count(*) from public.suppliers),
  (select count(*) from public.products),
  (select count(*) from public.product_images),
  (select count(*) from public.supplier_images),
  (select count(*) from public.subscriptions),
  (select md5(coalesce(string_agg((to_jsonb(s) - 'suspension_reason')::text, '|' order by s.id), ''))
     from public.suppliers s),
  (select md5(coalesce(string_agg((to_jsonb(p) - 'status' - 'suspended_at' - 'suspension_reason')::text, '|' order by p.id), ''))
     from public.products p),
  (select md5(coalesce(string_agg(to_jsonb(i)::text, '|' order by i.id), ''))
     from public.product_images i),
  (select md5(coalesce(string_agg(to_jsonb(si)::text, '|' order by si.id), ''))
     from public.supplier_images si),
  (select md5(coalesce(string_agg(to_jsonb(sub)::text, '|' order by sub.id), ''))
     from public.subscriptions sub),
  (select jsonb_object_agg(st, n) from (
     select coalesce(status, 'null') as st, count(*) as n
     from public.suppliers group by 1) x);

do $confere$
declare
  a _plm_foto;
  d _plm_foto;
  v_prod_nao_ativos int;
  v_reason_preenchido int;
begin
  select * into a from _plm_foto where momento = 'antes';
  select * into d from _plm_foto where momento = 'depois';

  if (a.suppliers, a.products, a.product_images, a.supplier_images, a.subscriptions,
      a.hash_suppliers, a.hash_products, a.hash_product_images, a.hash_supplier_images,
      a.hash_subscriptions, a.suppliers_por_status)
     is distinct from
     (d.suppliers, d.products, d.product_images, d.supplier_images, d.subscriptions,
      d.hash_suppliers, d.hash_products, d.hash_product_images, d.hash_supplier_images,
      d.hash_subscriptions, d.suppliers_por_status)
  then
    raise exception 'ABORTADO: dados mudaram durante a migration. antes=% depois=%',
      to_jsonb(a), to_jsonb(d);
  end if;

  -- Na 1ª execução todo produto tem de estar 'active' e nenhum motivo
  -- preenchido. Numa re-execução futura (depois da próxima etapa) isso pode
  -- legitimamente não valer -- por isso é aviso, não erro.
  select count(*) into v_prod_nao_ativos from public.products where status <> 'active';
  select (select count(*) from public.products where suspension_reason is not null)
       + (select count(*) from public.suppliers where suspension_reason is not null)
    into v_reason_preenchido;
  if v_prod_nao_ativos > 0 or v_reason_preenchido > 0 then
    raise notice 'Aviso: % produto(s) nao-active e % motivo(s) preenchido(s) -- esperado 0 na primeira execucao.',
      v_prod_nao_ativos, v_reason_preenchido;
  end if;
end
$confere$;

-- Guarda o resultado para depois do commit (a temp acima some no commit).
create temp table _plm_relatorio as
select * from _plm_foto;

commit;


-- ==========================================================================
-- 4) TESTES DE ESTRUTURA -- NÃO TOCAM NAS TABELAS REAIS
--
-- Cada CHECK é copiado do banco (pg_get_constraintdef) para uma tabela
-- temporária vazia, e os valores são testados nela. Assim o teste exercita a
-- regra que está DE FATO no banco sem gravar uma linha sequer em suppliers
-- ou products.
-- ==========================================================================

create temp table _plm_testes (teste text, esperado text, obtido text, ok boolean);

do $testes$
declare
  r record;
  v text;
  def text;
  resultado text;
begin
  for r in
    select * from (values
      ('suppliers', 'suppliers_suspension_reason_check', 'suspension_reason', array[null, 'plan_limit', 'no_plan'], array['suspended', 'xyz', '']),
      ('products',  'products_suspension_reason_check',  'suspension_reason', array[null, 'plan_limit', 'no_plan'], array['suspended', 'xyz', '']),
      ('products',  'products_status_check',             'status',            array['active', 'paused', 'suspended'], array['inactive', 'xyz', ''])
    ) t(tabela, constraint_name, coluna, aceitos, recusados)
  loop
    select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
    where c.conrelid = ('public.' || r.tabela)::regclass and c.conname = r.constraint_name;

    if def is null then
      insert into _plm_testes values (r.constraint_name || ' existe', 'sim', 'NAO', false);
      continue;
    end if;
    insert into _plm_testes values (r.constraint_name || ' existe', 'sim', 'sim', true);

    drop table if exists _plm_alvo;
    execute format('create temp table _plm_alvo (%I text)', r.coluna);
    execute format('alter table _plm_alvo add constraint c %s', def);

    foreach v in array r.aceitos loop
      begin
        execute format('insert into _plm_alvo (%I) values ($1)', r.coluna) using v;
        resultado := 'aceito';
      exception when check_violation then
        resultado := 'recusado';
      end;
      insert into _plm_testes values (r.tabela || '.' || r.coluna || ' = ' || coalesce(quote_literal(v), 'NULL'), 'aceito', resultado, resultado = 'aceito');
    end loop;

    foreach v in array r.recusados loop
      begin
        execute format('insert into _plm_alvo (%I) values ($1)', r.coluna) using v;
        resultado := 'aceito';
      exception when check_violation then
        resultado := 'recusado';
      end;
      insert into _plm_testes values (r.tabela || '.' || r.coluna || ' = ' || quote_literal(v), 'recusado', resultado, resultado = 'recusado');
    end loop;
  end loop;

  drop table if exists _plm_alvo;

  -- products.status: NOT NULL e default 'active' (o que mantém o Catálogo
  -- funcionando sem mandar status).
  insert into _plm_testes
  select 'products.status NOT NULL', 'sim',
         case when attnotnull then 'sim' else 'NAO' end, attnotnull
  from pg_attribute where attrelid = 'public.products'::regclass and attname = 'status';

  insert into _plm_testes
  select 'products.status default', '''active''::text',
         pg_get_expr(d.adbin, d.adrelid), pg_get_expr(d.adbin, d.adrelid) = '''active''::text'
  from pg_attrdef d
  join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
  where d.adrelid = 'public.products'::regclass and a.attname = 'status';

  insert into _plm_testes
  select 'products.suspended_at existe (timestamptz)', 'timestamp with time zone',
         format_type(atttypid, atttypmod), format_type(atttypid, atttypmod) = 'timestamp with time zone'
  from pg_attribute where attrelid = 'public.products'::regclass and attname = 'suspended_at' and not attisdropped;

  -- Estado dos dados depois da migration.
  insert into _plm_testes
  select 'products com status <> active', '0', count(*)::text, count(*) = 0
  from public.products where status <> 'active';
  insert into _plm_testes
  select 'products com suspension_reason preenchido', '0', count(*)::text, count(*) = 0
  from public.products where suspension_reason is not null;
  insert into _plm_testes
  select 'suppliers com suspension_reason preenchido', '0', count(*)::text, count(*) = 0
  from public.suppliers where suspension_reason is not null;

  -- QUEM PODE ESCREVER AS COLUNAS NOVAS (só informativo -- nada é alterado
  -- aqui; a proteção é a etapa de endurecimento).
  insert into _plm_testes values
    ('[info] authenticated pode UPDATE suppliers.suspension_reason', '-',
     has_column_privilege('authenticated', 'public.suppliers', 'suspension_reason', 'UPDATE')::text, null),
    ('[info] authenticated pode UPDATE products.status', '-',
     has_column_privilege('authenticated', 'public.products', 'status', 'UPDATE')::text, null),
    ('[info] authenticated pode UPDATE products.suspension_reason', '-',
     has_column_privilege('authenticated', 'public.products', 'suspension_reason', 'UPDATE')::text, null),
    ('[info] authenticated pode UPDATE products.suspended_at', '-',
     has_column_privilege('authenticated', 'public.products', 'suspended_at', 'UPDATE')::text, null);
end
$testes$;


-- ==========================================================================
-- 5) RESULTADO -- é esta a tabela que o SQL Editor mostra no final.
--    Linhas 'antes'/'depois' = integridade. Demais = testes.
-- ==========================================================================

select 'contagem ' || momento as teste,
       format('suppliers=%s products=%s product_images=%s supplier_images=%s subscriptions=%s status_anuncios=%s',
              suppliers, products, product_images, supplier_images, subscriptions, suppliers_por_status) as esperado,
       format('hash sup=%s prod=%s img=%s gal=%s sub=%s',
              left(hash_suppliers, 8), left(hash_products, 8), left(hash_product_images, 8),
              left(hash_supplier_images, 8), left(hash_subscriptions, 8)) as obtido,
       null::boolean as ok
from _plm_relatorio
union all
select teste, esperado, obtido, ok from _plm_testes;
