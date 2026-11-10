-- ==========================================================================
-- CORREÇÃO: o CHECK de suppliers.status não conhecia 'suspended'
--
-- O BUG, e ele é meu: billing-cycle-day-10.sql (seção 121) introduziu o
-- status 'suspended' para anúncios e acrescentou 'suspended' ao CHECK de
-- SUBSCRIPTIONS -- e esqueceu o CHECK de SUPPLIERS, que é justamente a
-- tabela onde o valor novo ia ser gravado.
--
-- CONSEQUÊNCIA, que era pior do que parece:
--   suspend_my_ads() estourava SEMPRE, com
--     23514 new row for relation "suppliers" violates check constraint
--     "suppliers_status_check"
--   Ela não tem tratamento de exceção, então o erro subia para quem a
--   chamou: sync_my_subscription(). Ou seja, TODO fornecedor sem plano
--   vigente tinha o sync abortado ao abrir o Dashboard -- e com ele a
--   promoção de assinatura agendada (passo b) e a suspensão (passo d).
--   A suspensão de anúncios NUNCA funcionou desde que foi escrita.
--
-- POR QUE NINGUÉM VIU: o caminho exige uma conta SEM plano vigente com
-- anúncio, que é o estado que ninguém tinha nas contas de teste. Os
-- cenários da spec §29 que cobriam isso (6 e 12) foram os que ficaram sem
-- exercitar (seção 132) -- e foram exatamente estes que quebraram assim que
-- o teste de fluxo passou a chamar suspend_my_ads() de verdade.
--
-- Encontrado por src/api/subscription-flow.test.js na primeira execução
-- (seção 133). É o argumento inteiro a favor daquele arquivo: o bug estava
-- no banco desde a seção 121, passou por duas rodadas de verificação manual
-- e por um relatório meu dizendo que a suspensão estava "no banco".
--
-- ADITIVO E SEGURO: só troca uma restrição por outra MAIS PERMISSIVA (o
-- conjunto antigo mais 'suspended'). Nenhuma linha existente pode violar a
-- nova, porque nenhuma delas tem 'suspended' hoje -- justamente por causa
-- do bug.
-- ==========================================================================

-- Derruba qualquer CHECK de status que exista em suppliers, seja qual for o
-- nome. Mesmo padrão usado em subscription-plan-change.sql: o nome do
-- constraint pode ter sido gerado pelo Postgres ou por uma migração antiga,
-- e escrever o nome na mão é apostar em qual deles está lá.
do $status_check$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.suppliers'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.suppliers drop constraint %I', c.conname);
  end loop;
end
$status_check$;

alter table public.suppliers
  add constraint suppliers_status_check
  check (status in ('active', 'paused', 'suspended'));

notify pgrst, 'reload schema';

-- ==========================================================================
-- COMO CONFERIR
--
--   select pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.suppliers'::regclass and conname = 'suppliers_status_check';
--
-- Esperado: CHECK (status = ANY (ARRAY['active', 'paused', 'suspended']))
--
-- E, de verdade, pelo comportamento: `npm test` com TEST_ASSINATURA_EMAIL
-- apontando para uma conta com anúncio. O teste "SUSPENDER preserva a
-- intenção do fornecedor e some da vitrine" é o que falhava.
--
-- Re-executável: o bloco derruba antes de criar.
-- ==========================================================================
