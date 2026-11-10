-- *** 2026-11-03 (C1, Resumo.md §231-232): o subscribe_to_plan deste arquivo
-- ganhou a guarda PAYMENT_REQUIRED (só o Básico). A versão VIVA é a de
-- fix-paid-plan-activation.sql; se re-rodar este arquivo, rode depois
-- plan-limits-central.sql e fix-paid-plan-activation.sql (nessa ordem).
-- Com asaas-billing.sql instalado, o gatilho trg_guard_paid_subscription
-- recusa assinatura paga sem pagamento aprovado mesmo assim. ***
-- ==========================================================================
-- CICLO DE COBRANÇA NO DIA 10 + UPGRADE IMEDIATO + SUSPENSÃO SEM PERDA
--
-- Implementa a especificação de planos/assinaturas de 2026-09-21
-- (CONTEXTO.MD/Resumo.md seção 121). NÃO implementa gateway, cobrança,
-- webhook nem cálculo financeiro -- só a vigência e a preparação dos campos.
--
-- SUBSTITUI funções que já existiam:
--   subscribe_to_plan          (de plan-change-at-period-end.sql)
--   cancel_my_subscription     (de cancel-clears-scheduled-change.sql)
--   reactivate_my_subscription (de rls-policies.sql)
--   sync_my_subscription       (de subscription-plan-change.sql)
--   company_public_products    (de product-catalog.sql)
--
-- >>> ESTE ARQUIVO VAI POR ÚLTIMO. Re-rodar qualquer um dos anteriores
-- >>> depois dele reverte estas regras EM SILÊNCIO, sem erro e sem quebra
-- >>> visível. Ver o parágrafo sobre ordem dos arquivos no CLAUDE.md. <<<
--
-- ORDEM COMPLETA HOJE:
--   1. rls-policies.sql                  (base)
--   2. subscription-plan-change.sql
--   3. plan-change-at-period-end.sql
--   4. cancel-clears-scheduled-change.sql
--   5. product-catalog.sql
--   6. ESTE ARQUIVO
--
-- DECISÕES TOMADAS COM O USUÁRIO ANTES DE ESCREVER (seção 121):
--   * Assinaturas JÁ EXISTENTES não são reancoradas. Nenhum UPDATE em massa
--     em expires_at -- reescrever período pago é mexer no que a pessoa já
--     comprou. Elas migram sozinhas na próxima transição.
--   * O Básico continua GRÁTIS e SEM VENCIMENTO (expires_at = 'infinity'),
--     nunca é cobrado, e participa da hierarquia por plan_rank().
--   * O primeiro ciclo parcial é REGISTRADO (first_cycle_partial /
--     partial_days), sem nenhum cálculo de valor -- é o gateway futuro que
--     decide quanto cobrar por ele.
-- ==========================================================================


-- ==========================================================================
-- 1) COLUNAS NOVAS -- todas aditivas. Nenhuma coluna é removida ou renomeada.
-- ==========================================================================

-- QUANDO O DINHEIRO SERIA COBRADO, sempre um dia 10.
-- Separada de expires_at de propósito: expires_at é ATÉ QUANDO O ACESSO
-- VALE. Hoje as duas coincidem nas linhas novas, mas o gateway futuro vai
-- precisar distinguir -- por exemplo, cobrança falha no dia 10 e o acesso
-- continua durante as tentativas dos dias 11 e 13 (spec §11).
-- NULL = não há nada a cobrar (Básico, cancelada, encerrada).
alter table public.subscriptions
  add column if not exists next_charge_at timestamptz;

-- O primeiro ciclo quase nunca tem 30 dias: quem assina no dia 21 tem acesso
-- até o dia 10 seguinte. Estes dois campos REGISTRAM esse período parcial
-- sem calcular valor nenhum (a spec §5 proíbe cálculo financeiro agora).
-- Sem eles, quando o gateway entrar não haveria como saber quais assinaturas
-- tiveram ciclo parcial nem de quantos dias -- o dado se perderia.
alter table public.subscriptions
  add column if not exists first_cycle_partial boolean not null default false;

alter table public.subscriptions
  add column if not exists partial_days integer;

-- 'suspended' entra agora para a assinatura suspensa por falha de pagamento
-- (spec §11/§17). NENHUMA função desta rodada produz esse status -- não há
-- cobrança para falhar. Ele existe para que o gateway futuro não precise
-- mexer no CHECK constraint, que é a parte arriscada desta tabela.
do $status_check$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.subscriptions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.subscriptions drop constraint %I', c.conname);
  end loop;
end
$status_check$;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active', 'cancelled', 'expired', 'scheduled', 'suspended'));

-- ---------------------------------------------------------------- suppliers
-- SUSPENSÃO DO ANÚNCIO SEM APAGAR NADA (spec §10/§23).
--
-- POR QUE UM STATUS NOVO E NÃO UMA COLUNA BOOLEANA: a policy de SELECT de
-- suppliers (rls-policies.sql) já filtra coalesce(status,'active')='active'.
-- Um status 'suspended' fica invisível em TODA leitura pública
-- automaticamente -- listagem, home, busca por empresa, perfil do anúncio.
-- Uma coluna booleana à parte exigiria lembrar de filtrar em cada um desses
-- lugares, e esquecer um deles VAZARIA o anúncio suspenso. Status é à prova
-- de falha; coluna à parte é à prova de memória.
--
-- E POR QUE GUARDAR O STATUS ANTERIOR: 'paused' é o mesmo valor que o
-- PRÓPRIO fornecedor usa no botão de pausar. Se a suspensão sobrescrevesse
-- isso, na volta do plano seria impossível saber quais anúncios ele tinha
-- pausado de propósito -- e reativar todos passaria por cima da decisão
-- dele (spec §12).
alter table public.suppliers
  add column if not exists status_before_suspension text;

alter table public.suppliers
  add column if not exists suspended_at timestamptz;


-- ==========================================================================
-- 2) A DATA OFICIAL DE COBRANÇA -- dia 10, 00:00, America/Sao_Paulo
--
-- Uma função só, usada por todo mundo, para que a regra do dia 10 exista em
-- UM lugar. O fuso é explícito porque o Postgres do Supabase roda em UTC:
-- um cálculo ingênuo deslocaria o dia 10 em 3 horas, mudando o DIA para quem
-- assina entre 21h e meia-noite de Brasília (spec §24).
--
-- "Estritamente depois": no próprio dia 10 a resposta é o dia 10 do mês
-- seguinte, porque a cobrança daquele dia é a que está acontecendo agora.
--
-- date_trunc('month', x) + 9 dias = dia 10 daquele mês (dia 1 + 9).
-- ==========================================================================

create or replace function public.next_billing_date(p_from timestamptz default now())
 returns timestamptz
 language sql
 stable
as $function$
  select case
    when (p_from at time zone 'America/Sao_Paulo')
         < (date_trunc('month', p_from at time zone 'America/Sao_Paulo') + interval '9 days')
      then (date_trunc('month', p_from at time zone 'America/Sao_Paulo') + interval '9 days')
           at time zone 'America/Sao_Paulo'
    else (date_trunc('month', p_from at time zone 'America/Sao_Paulo') + interval '1 month 9 days')
         at time zone 'America/Sao_Paulo'
  end;
$function$;

comment on function public.next_billing_date(timestamptz) is
  'Proximo dia 10 as 00:00 em America/Sao_Paulo, estritamente depois de p_from. Data oficial de cobranca do NEXAR (spec secao 4).';

grant execute on function public.next_billing_date(timestamptz) to authenticated;


-- ==========================================================================
-- 4) SUSPENSÃO E RESTAURAÇÃO DOS ANÚNCIOS
--
-- Declaradas ANTES de subscribe_to_plan porque ele as chama. Em plpgsql a
-- resolução é em tempo de execução, então a ordem não seria obrigatória --
-- mas deixar a dependência antes de quem depende evita que uma execução
-- parcial do arquivo crie uma função que chama outra inexistente.
-- ==========================================================================

create or replace function public.suspend_my_ads()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  -- Guarda o status atual antes de sobrescrever -- é ele que a restauração
  -- vai ler. A cláusula `status_before_suspension is null` torna a função
  -- idempotente: suspender de novo não sobrescreve a memória do valor
  -- original com 'suspended'.
  update public.suppliers
  set status_before_suspension = coalesce(status, 'active'),
      status = 'suspended',
      suspended_at = now()
  where created_by = v_uid
    and coalesce(status, 'active') <> 'suspended'
    and status_before_suspension is null;
end;
$function$;

create or replace function public.restore_my_suspended_ads()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return;
  end if;

  -- Volta exatamente ao que era antes. Quem estava 'paused' continua
  -- 'paused': a decisão do fornecedor sobrevive à suspensão.
  update public.suppliers
  set status = coalesce(status_before_suspension, 'active'),
      status_before_suspension = null,
      suspended_at = null
  where created_by = v_uid
    and status = 'suspended';
end;
$function$;

revoke execute on function public.suspend_my_ads() from public, anon;
revoke execute on function public.restore_my_suspended_ads() from public, anon;
grant execute on function public.suspend_my_ads() to authenticated;
grant execute on function public.restore_my_suspended_ads() to authenticated;


-- ==========================================================================
-- 3) `subscribe_to_plan` -- REESCRITA: upgrade imediato, downgrade no dia 10
--
-- O QUE MUDOU EM RELAÇÃO À VERSÃO ANTERIOR
-- Antes o que decidia era "o fornecedor já paga?": qualquer troca entre
-- planos pagos ia para o fim do ciclo, nos DOIS sentidos. Agora o que decide
-- é a DIREÇÃO, por plan_rank() (spec §6/§7):
--
--   sem plano vigente            IMEDIATO   (ciclo parcial ate o dia 10)
--   rank maior   (UPGRADE)       IMEDIATO   (sem cobranca agora)
--   rank menor   (DOWNGRADE)     DIA 10     (plano atual intacto ate la)
--
-- O Básico deixou de ser um `if` especial: com rank 0, sair dele para um
-- plano pago É um upgrade e cai no ramo imediato naturalmente. A exceção
-- virou consequência da hierarquia -- que é exatamente o que a spec pediu ao
-- mandar usar "a hierarquia real dos planos existente no projeto".
-- ==========================================================================

create or replace function public.subscribe_to_plan(p_plan_id text)
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscriptions;
  v_row public.subscriptions;
  v_end timestamptz;
  v_starts timestamptz;
  v_is_paid boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_plan_id is null or p_plan_id not in ('basico', 'profissional', 'premium') then
    raise exception 'INVALID_PLAN';
  end if;
  -- C1 (Resumo.md §231-232): plano pago NÃO se ativa por esta RPC -- só o
  -- backend, com pagamento aprovado (asaas-billing.sql). Acrescentado em
  -- 2026-11-03 também a esta versão antiga, para que re-rodar este arquivo
  -- não reabra a falha. O gatilho trg_guard_paid_subscription recusa a
  -- linha paga de qualquer forma.
  if p_plan_id is distinct from 'basico' then
    raise exception 'PAYMENT_REQUIRED'
      using hint = 'Planos pagos só são ativados depois de pagamento confirmado.';
  end if;

  v_is_paid := p_plan_id <> 'basico';

  -- Assinatura que está DANDO BENEFÍCIO agora. 'cancelled' entra porque o
  -- plano cancelado continua valendo até o vencimento (spec §8).
  select * into v_current
  from public.subscriptions
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and started_at <= now()
    and expires_at > now()
  order by started_at desc
  limit 1;

  -- ---------- SEM PLANO VIGENTE: entra na hora, ciclo parcial ----------
  if v_current.id is null then
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

    v_end := public.next_billing_date(now());

    insert into public.subscriptions (
      created_by, plan_id, status, started_at, expires_at,
      next_charge_at, first_cycle_partial, partial_days
    )
    values (
      v_uid, p_plan_id, 'active', now(),
      case when v_is_paid then v_end else 'infinity'::timestamptz end,
      case when v_is_paid then v_end else null end,
      v_is_paid,
      -- greatest(1, ...): assinar no dia 9 dá 1 dia de ciclo parcial, nunca 0
      -- nem negativo. Zero faria o gateway futuro tratar como ciclo cheio.
      case when v_is_paid then greatest(1, (v_end::date - now()::date)) else null end
    )
    returning * into v_row;

    perform public.restore_my_suspended_ads();
    return v_row;
  end if;

  if v_current.plan_id = p_plan_id then
    raise exception 'ALREADY_ON_PLAN';
  end if;

  -- ---------- UPGRADE: vale agora, SEM cobrança agora ----------
  if public.plan_rank(p_plan_id) > public.plan_rank(v_current.plan_id) then
    delete from public.subscriptions
    where created_by = v_uid and status = 'scheduled';

    if not v_is_paid then
      -- Não existe upgrade PARA o Básico (rank 0 é o menor). Se a hierarquia
      -- mudar um dia, isto evita um insert silenciosamente errado.
      v_end := 'infinity'::timestamptz;
    elsif v_current.expires_at = 'infinity'::timestamptz then
      -- Saindo do Básico: não há ciclo anterior a preservar.
      v_end := public.next_billing_date(now());
    else
      -- O fim do ciclo é o dia 10 que já estava valendo.
      -- `greatest` protege as linhas ANTIGAS, criadas antes desta regra com
      -- expires_at em data arbitrária: elas migram para o dia 10 sem NUNCA
      -- encurtar o período já pago. Numa linha criada por esta versão,
      -- expires_at já é um dia 10, então o greatest não muda nada.
      v_end := greatest(v_current.expires_at, public.next_billing_date(now()));
    end if;

    -- O plano antigo é ENCERRADO. A spec §6 é explícita: "Não manter o plano
    -- antigo ativo até o fim do ciclo quando for upgrade."
    update public.subscriptions
    set status = 'expired', expires_at = now(), next_charge_at = null
    where id = v_current.id;

    insert into public.subscriptions (
      created_by, plan_id, status, started_at, expires_at,
      next_charge_at, first_cycle_partial, partial_days
    )
    values (
      v_uid, p_plan_id, 'active', now(), v_end,
      case when v_is_paid then v_end else null end,
      -- Não é primeiro ciclo: o fornecedor já vinha de um plano vigente.
      false, null
    )
    returning * into v_row;

    perform public.restore_my_suspended_ads();
    return v_row;
  end if;

  -- ---------- DOWNGRADE: vale no fim do ciclo (dia 10) ----------
  -- O plano atual segue INTACTO até expires_at. Nada é encerrado aqui: o
  -- fornecedor pagou por esses dias, e a spec §7 diz "não retirar recursos do
  -- plano atual antes da data da mudança".
  if v_current.expires_at = 'infinity'::timestamptz then
    -- O Básico não tem fim de ciclo de onde partir, e não há plano abaixo
    -- dele. Inalcançável pela hierarquia atual; falha explícito em vez de
    -- criar um agendamento que nunca entraria em vigor.
    raise exception 'CANNOT_SCHEDULE_FROM_UNLIMITED_PLAN';
  end if;

  v_starts := v_current.expires_at;

  -- Só pode haver um agendamento (índice único subscriptions_one_scheduled_
  -- per_user). O novo substitui o anterior, e é isso que deixa o fornecedor
  -- trocar de ideia quantas vezes quiser antes da virada.
  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  insert into public.subscriptions (
    created_by, plan_id, status, started_at, expires_at,
    next_charge_at, first_cycle_partial, partial_days
  )
  values (
    v_uid, p_plan_id, 'scheduled', v_starts,
    case when v_is_paid then public.next_billing_date(v_starts) else 'infinity'::timestamptz end,
    case when v_is_paid then v_starts else null end,
    false, null
  )
  returning * into v_row;

  return v_row;
end;
$function$;

revoke execute on function public.subscribe_to_plan(text) from public, anon;
grant execute on function public.subscribe_to_plan(text) to authenticated;


-- ==========================================================================
-- 5) `sync_my_subscription` -- REESCRITA
--
-- Mesmos 4 passos de antes, com duas mudanças:
--   * a pausa por falta de plano virou SUSPENSÃO (status 'suspended' com
--     memória do valor anterior), em vez de sobrescrever 'paused' e perder a
--     intenção do fornecedor;
--   * quando há plano vigente, RESTAURA o que estava suspenso -- é o que
--     cumpre a spec §12 sem o fornecedor ter de reativar anúncio por anúncio.
-- ==========================================================================

create or replace function public.sync_my_subscription()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_has_benefits boolean;
begin
  if v_uid is null then
    return;
  end if;

  -- (a) encerra o que venceu -- libera o slot do índice único de 'active'
  update public.subscriptions
  set status = 'expired', next_charge_at = null
  where created_by = v_uid
    and status in ('active', 'cancelled')
    and expires_at <= now();

  -- (b) promove o agendamento cuja data chegou
  update public.subscriptions
  set status = 'active'
  where created_by = v_uid
    and status = 'scheduled'
    and started_at <= now();

  -- (c) se o promovido já nasceu vencido (fornecedor sumiu por muito tempo),
  --     encerra também
  update public.subscriptions
  set status = 'expired', next_charge_at = null
  where created_by = v_uid
    and status = 'active'
    and expires_at <= now();

  -- (d) suspende ou restaura, conforme sobrou plano vigente
  select exists (
    select 1 from public.subscriptions
    where created_by = v_uid
      and status in ('active', 'cancelled')
      and started_at <= now()
      and expires_at > now()
  ) into v_has_benefits;

  if v_has_benefits then
    perform public.restore_my_suspended_ads();
  else
    perform public.suspend_my_ads();
  end if;
end;
$function$;

revoke execute on function public.sync_my_subscription() from public, anon;
grant execute on function public.sync_my_subscription() to authenticated;


-- ==========================================================================
-- 6) `cancel_my_subscription` -- cancelamento AGENDADO (spec §8)
--
-- Cancelar NÃO tira o plano na hora. O acesso continua até o fim do período
-- (que nas linhas novas já é um dia 10) e só então a assinatura é encerrada
-- -- e o fornecedor fica SEM PLANO, nunca convertido em Básico (spec §2).
--
-- MANTÉM o delete do agendamento (seção 117): cancelar é dizer que quer
-- sair, e manter viva uma troca contratada enquanto queria ficar é manter
-- uma intenção que deixou de existir.
--
-- NOVO AQUI: next_charge_at = null. É a linha que diz ao gateway futuro
-- "não cobre mais esta assinatura". Sem ela o cancelamento seria apenas
-- visual e a cobrança seguiria agendada.
--
-- expires_at NÃO é reescrito para o dia 10. Reancorar aqui mexeria no
-- período já pago de quem tem linha antiga -- a decisão da seção 121 foi
-- explicitamente não fazer isso.
-- ==========================================================================

create or replace function public.cancel_my_subscription()
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'active' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_ACTIVE_SUBSCRIPTION';
  end if;

  -- Antes do update: se algo falhar abaixo, a transação inteira volta atrás.
  -- Assinatura cancelada com agendamento vivo é o estado que isto impede.
  delete from public.subscriptions
  where created_by = v_uid and status = 'scheduled';

  if v_row.plan_id = 'basico' then
    -- Gratuito: não há período pago a preservar, o cancelamento é imediato e
    -- o fornecedor fica sem plano na hora -- com os anúncios suspensos, não
    -- apagados.
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), expires_at = now(), next_charge_at = null
    where id = v_row.id
    returning * into v_row;

    perform public.suspend_my_ads();
  else
    update public.subscriptions
    set status = 'cancelled', cancelled_at = now(), next_charge_at = null
    where id = v_row.id
    returning * into v_row;
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.cancel_my_subscription() from public, anon;
grant execute on function public.cancel_my_subscription() to authenticated;


-- ==========================================================================
-- 7) `reactivate_my_subscription` -- "cancelar o cancelamento" (spec §9)
--
-- NOVO: restaura next_charge_at. Sem isso, desfazer o cancelamento devolvia
-- o plano mas deixava a cobrança desligada -- o fornecedor seguiria usando
-- sem cobrança até o vencimento, e o gateway futuro não teria o que cobrar.
-- A data volta a ser o fim do ciclo vigente, que é de onde ela saiu.
-- ==========================================================================

create or replace function public.reactivate_my_subscription()
 returns subscriptions
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_row public.subscriptions;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_row from public.subscriptions
  where created_by = v_uid and status = 'cancelled' and expires_at > now()
  order by started_at desc
  limit 1;

  if v_row.id is null then
    raise exception 'NO_CANCELLED_SUBSCRIPTION';
  end if;

  update public.subscriptions
  set status = 'active',
      cancelled_at = null,
      next_charge_at = case when v_row.plan_id = 'basico' then null else v_row.expires_at end
  where id = v_row.id
  returning * into v_row;

  perform public.restore_my_suspended_ads();
  return v_row;
end;
$function$;

revoke execute on function public.reactivate_my_subscription() from public, anon;
grant execute on function public.reactivate_my_subscription() to authenticated;


-- ==========================================================================
-- 8) CATÁLOGO PÚBLICO DA EMPRESA respeita a suspensão (spec §23)
--
-- Os ANÚNCIOS somem sozinhos ao ficarem 'suspended', porque a policy de
-- SELECT de suppliers já filtra por status. O CATÁLOGO DA EMPRESA não:
-- company_public_products é security definer e IGNORA RLS por definição,
-- listando os produtos da conta independentemente dos anúncios. Sem esta
-- correção, a vitrine de produtos de um fornecedor sem plano continuaria
-- pública em SupplierProfile?view=empresa.
--
-- ESTA FUNÇÃO É A DE product-catalog.sql COPIADA LITERALMENTE, com UMA
-- cláusula a mais (o `and exists (...)` do plano). Nada mais muda:
--
--   * as 10 colunas do `returns table` estão na MESMA ordem e com os MESMOS
--     tipos. `create or replace function` NÃO PODE mudar o tipo de retorno
--     -- o Postgres recusa com "cannot change return type of existing
--     function" e o script inteiro aborta;
--   * `images` continua sendo jsonb_agg(pi.url), ou seja, uma lista de
--     STRINGS de url -- não de objetos. CompanyProductsSection/ProductCardMini
--     consomem esse formato;
--   * os casts explícitos (::text, ::numeric, ::integer, ::boolean) ficam.
--     O comentário do arquivo original avisa por quê: `returns table` estoura
--     em tempo de EXECUÇÃO ("structure of query does not match function
--     result type") se o tipo real da coluna divergir do declarado;
--   * o `order by p.created_at desc nulls last` fica.
--
-- ------------------------------------------------- POR QUE O DROP ABAIXO ---
-- Duas tentativas de rodar este arquivo morreram aqui com
--
--   ERROR 42P13: cannot change return type of existing function
--   HINT: Use DROP FUNCTION company_public_products(uuid) first.
--
-- Na primeira vez a culpa era minha: eu tinha escrito a função de memória,
-- com 6 colunas em vez de 10 (seção 122). Na segunda, já com a assinatura
-- copiada LITERALMENTE de product-catalog.sql, o erro se repetiu -- o que
-- prova que a função VIVA NO BANCO não é a daquele arquivo. Faz sentido:
-- o CLAUDE.md sempre disse que product-catalog.sql nunca foi rodado contra
-- o banco. Alguma outra versão de company_public_products está lá, de
-- origem desconhecida.
--
-- `create or replace` não consegue mudar row type, e não dá para casar com
-- uma assinatura que ninguém sabe qual é. O drop resolve independentemente
-- do que estiver lá, e é a saída que o próprio Postgres indica.
--
-- É SEGURO: (1) função não guarda dado, então dropar não perde nada;
-- (2) nada no banco depende dela -- não há view, trigger ou função que a
-- chame, só o client via RPC; (3) drop e create estão na MESMA transação do
-- script, então nunca existe um instante com a função ausente para quem
-- estiver usando o site; (4) os grants são refeitos logo abaixo.
--
-- A forma recriada é a que o client realmente consome: ProductCardMini.jsx
-- lê name, description, price, unit, min_quantity, in_stock, e
-- CompanyProductsSection.jsx lê id e images. Todos os oito estão aqui.
-- ==========================================================================

drop function if exists public.company_public_products(uuid);

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
  -- ÚNICA LINHA NOVA: sem plano vigente, o catálogo público some (spec §23).
  and exists (
    select 1 from public.subscriptions sub
    where sub.created_by = p.created_by
      and sub.status in ('active', 'cancelled')
      and sub.started_at <= now()
      and sub.expires_at > now()
  )
  order by p.created_at desc nulls last;
$function$;

revoke execute on function public.company_public_products(uuid) from public;
grant execute on function public.company_public_products(uuid) to anon, authenticated;


notify pgrst, 'reload schema';


-- ==========================================================================
-- COMO CONFERIR QUE ESTA VERSÃO É A QUE ESTÁ NO BANCO
--
-- A lição das seções 98 e 110: quando um arquivo SUBSTITUI funções que já
-- existiam, testar "a RPC responde" NÃO PROVA NADA -- a versão antiga
-- responde igual, e os revoke/grant daqui são idênticos aos anteriores.
-- Tem que olhar o corpo:
--
--   select proname,
--          position('plan_rank(p_plan_id) >' in prosrc) > 0 as upgrade_por_rank,
--          position('restore_my_suspended_ads' in prosrc) > 0 as tem_restauracao
--   from pg_proc
--   where proname in ('subscribe_to_plan', 'sync_my_subscription',
--                     'cancel_my_subscription', 'reactivate_my_subscription')
--   order by proname;
--
-- Esperado: subscribe_to_plan  upgrade_por_rank = true, tem_restauracao = true
--           sync_my_subscription                        tem_restauracao = true
--           reactivate_my_subscription                  tem_restauracao = true
--
-- E a data oficial (tem que cair num dia 10):
--   select public.next_billing_date(now());
--
-- Estruturalmente re-executável: `add column if not exists`, `create or
-- replace`, o bloco do CHECK que derruba antes de recriar, e o
-- `drop function if exists` (o `if exists` é o que o torna re-executável --
-- um drop nu falharia na segunda passada). Não há DDL que aborte numa
-- segunda execução. Pela regra da seção 94, só vira
-- re-executável VERIFICADO depois de uma segunda execução sem erro.
-- ==========================================================================
