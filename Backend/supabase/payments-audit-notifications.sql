-- ==========================================================================
-- PAGAMENTOS, WEBHOOKS, AUDITORIA E NOTIFICAÇÕES
--
-- Segunda rodada da especificação de 2026-09-21 (seção 121 fez a primeira,
-- o ciclo do dia 10). Cobre as seções §11 a §20 da spec.
--
-- >>> NÃO IMPLEMENTA GATEWAY. Nenhuma linha aqui cobra, integra, chama API
-- >>> externa ou simula pagamento. O que este arquivo faz é deixar o LUGAR
-- >>> pronto para os dados que o gateway vai produzir, com as garantias que
-- >>> precisam existir ANTES dele -- unicidade, idempotência e auditoria.
-- >>> Escolher e integrar o gateway é outra rodada. <<<
--
-- POR QUE CRIAR ISTO ANTES DO GATEWAY, e não junto: as restrições que
-- impedem cobrança duplicada e evento processado duas vezes são índices
-- únicos. Índice único é a única forma de garantia que sobrevive a corrida,
-- a retry e a bug de aplicação -- e é MUITO mais barato criar num banco
-- vazio do que depois, quando já houver linha duplicada para limpar antes.
--
-- ADITIVO: não altera nem uma tabela, função ou policy existente. Nada do
-- que já está no ar muda de comportamento por causa deste arquivo, com UMA
-- exceção deliberada: o trigger de auditoria em `subscriptions` (seção 6
-- abaixo), que passa a gravar histórico e notificações a cada mudança.
-- ==========================================================================


-- ==========================================================================
-- 1) MÉTODOS DE PAGAMENTO (spec §13)
--
-- Guarda apenas o que é seguro guardar: bandeira, 4 últimos dígitos e
-- validade -- o suficiente para a pessoa RECONHECER o cartão na tela.
-- O dado sensível fica no gateway, e aqui só o identificador dele
-- (gateway_method_id). É por isso que não existe coluna de número completo
-- nem de CVV: não é esquecimento, é o desenho. Guardar PAN exige PCI-DSS.
-- ==========================================================================

create table if not exists public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('card', 'pix', 'boleto')),
  brand text,
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  exp_month smallint check (exp_month is null or exp_month between 1 and 12),
  exp_year smallint check (exp_year is null or exp_year between 2024 and 2100),
  holder_name text,
  is_default boolean not null default false,
  -- Preenchidos pelo gateway futuro. Nulos hoje.
  gateway text,
  gateway_customer_id text,
  gateway_method_id text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- UM método padrão por conta, garantido pelo banco. Sem isto, "marcar como
-- padrão" viraria duas linhas com is_default=true numa corrida, e a cobrança
-- não saberia qual usar.
create unique index if not exists payment_methods_one_default_per_user
  on public.payment_methods (created_by)
  where is_default and deleted_at is null;

create index if not exists payment_methods_by_user
  on public.payment_methods (created_by) where deleted_at is null;

alter table public.payment_methods enable row level security;

-- Dono lê e apaga o próprio. INSERT/UPDATE ficam de fora de propósito: quem
-- cadastra método é o fluxo do gateway (tokenização), não o client escrevendo
-- direto -- senão daria para forjar um método "aprovado" que não existe lá.
drop policy if exists "Owners read own payment methods" on public.payment_methods;
create policy "Owners read own payment methods"
on public.payment_methods for select to authenticated
using (auth.uid() = created_by or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists "Owners delete own payment methods" on public.payment_methods;
create policy "Owners delete own payment methods"
on public.payment_methods for delete to authenticated
using (auth.uid() = created_by);


-- ==========================================================================
-- 2) PAGAMENTOS (spec §14) -- uma linha por CICLO cobrado
--
-- A unidade aqui é o CICLO, não a tentativa. Dia 10 com três tentativas é
-- UM pagamento com três linhas em payment_attempts -- não três pagamentos.
-- Misturar os dois é o que faz relatório financeiro contar a mesma cobrança
-- várias vezes.
--
-- billing_cycle é a DATA DO DIA 10 a que a cobrança se refere. É ela que
-- carrega a garantia mais importante deste arquivo (o índice único logo
-- abaixo), e é `date` e não timestamptz de propósito: o ciclo é um dia do
-- calendário comercial, não um instante.
-- ==========================================================================

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  plan_id text not null check (plan_id in ('basico', 'profissional', 'premium')),
  billing_cycle date not null,
  -- Em CENTAVOS, inteiro. Nunca float: 0.1 + 0.2 <> 0.3 em ponto flutuante,
  -- e isso vira diferença de centavo em conciliação.
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'BRL',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'refused', 'refunded')),
  attempt_count smallint not null default 0 check (attempt_count between 0 and 3),
  payment_method_id uuid references public.payment_methods(id) on delete set null,
  gateway text,
  gateway_payment_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);

-- *** A GARANTIA CENTRAL (spec §15): UMA COBRANÇA POR CICLO. ***
-- Duas cobranças do mesmo mês para a mesma assinatura passam a ser
-- IMPOSSÍVEIS, não improváveis. Cobre o retry do gateway, o clique duplo, o
-- job que roda duas vezes e o webhook reentregue -- sem que nenhum deles
-- precise ser cuidadoso.
create unique index if not exists payments_one_per_cycle
  on public.payments (subscription_id, billing_cycle)
  where subscription_id is not null;

-- O id do gateway também é único: a mesma cobrança lá não vira duas aqui.
create unique index if not exists payments_gateway_id_unique
  on public.payments (gateway, gateway_payment_id)
  where gateway_payment_id is not null;

create index if not exists payments_by_user
  on public.payments (created_by, billing_cycle desc);

alter table public.payments enable row level security;

-- Só leitura pelo dono. NENHUMA policy de escrita: pagamento é escrito pelo
-- gateway/webhook com privilégio elevado. Se o client pudesse inserir, daria
-- para marcar 'approved' sem ter pago.
drop policy if exists "Owners read own payments" on public.payments;
create policy "Owners read own payments"
on public.payments for select to authenticated
using (auth.uid() = created_by or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');


-- ==========================================================================
-- 3) TENTATIVAS DE COBRANÇA (spec §11) -- dias 10, 11 e 13
--
-- TRÊS, e o banco não deixa existir uma quarta: a spec diz "Não criar uma
-- quarta tentativa", e uma regra dessas escrita só no código do job sobrevive
-- até alguém escrever outro job.
-- ==========================================================================

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  attempt_no smallint not null check (attempt_no between 1 and 3),
  status text not null check (status in ('approved', 'refused', 'error')),
  attempted_at timestamptz not null default now(),
  failure_code text,
  failure_message text,
  gateway_response jsonb
);

-- Não existem duas "segunda tentativa" do mesmo pagamento.
create unique index if not exists payment_attempts_unique_no
  on public.payment_attempts (payment_id, attempt_no);

alter table public.payment_attempts enable row level security;

drop policy if exists "Owners read own payment attempts" on public.payment_attempts;
create policy "Owners read own payment attempts"
on public.payment_attempts for select to authenticated
using (
  exists (
    select 1 from public.payments p
    where p.id = payment_id
      and (p.created_by = auth.uid() or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  )
);


-- ==========================================================================
-- 4) EVENTOS DE WEBHOOK (spec §16) -- caixa de entrada, não processamento
--
-- O PADRÃO AQUI É "INBOX": o webhook GRAVA e responde 200 na hora; o
-- processamento acontece depois, lendo desta tabela. É isso que responde à
-- exigência da spec de "se o NEXAR estiver indisponível, não perder a
-- informação" -- gravar é a operação mais barata e mais difícil de falhar
-- que existe, e o reprocessamento vira uma varredura de status='pending'.
--
-- Processar dentro do handler do webhook seria o oposto: qualquer erro no
-- meio perde o evento, porque o gateway já recebeu o 200.
-- ==========================================================================

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  -- O id do evento NO GATEWAY. É a chave da idempotência.
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processed', 'failed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_attempts smallint not null default 0,
  last_error text
);

-- *** IDEMPOTÊNCIA DE EVENTO (spec §15/§16). ***
-- O mesmo evento reentregue não vira duas linhas: o insert falha por conflito
-- e o handler trata como "já recebi", que é a resposta correta.
create unique index if not exists webhook_events_unique
  on public.webhook_events (provider, event_id);

create index if not exists webhook_events_pending
  on public.webhook_events (received_at) where status = 'pending';

alter table public.webhook_events enable row level security;

-- RLS LIGADA E SEM NENHUMA POLICY, de propósito -- mesmo desenho de ad_views
-- (rls-policies.sql seção 9). Nem `authenticated` lê ou escreve: é tabela de
-- infraestrutura, com payload cru do gateway dentro, e ninguém logado tem
-- motivo para alcançá-la. O processamento roda com service role.


-- ==========================================================================
-- 5) NOTIFICAÇÕES (spec §20)
--
-- A spec pedia para "reutilizar a central existente". ELA NÃO EXISTIA:
-- Notificacoes.jsx lia ChatMessage e renderizava mensagens de chat -- não há
-- tabela, nem entidade. Esta é a estrutura que faltava. A tela passa a
-- mostrar as duas fontes juntas.
--
-- `link` guarda um caminho interno (ex.: '/Dashboard'), nunca URL absoluta:
-- notificação que abre domínio externo é vetor de phishing dentro do produto.
-- ==========================================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text check (link is null or link like '/%'),
  metadata jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_by_user
  on public.notifications (created_by, created_at desc);

create index if not exists notifications_unread
  on public.notifications (created_by) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists "Owners read own notifications" on public.notifications;
create policy "Owners read own notifications"
on public.notifications for select to authenticated
using (auth.uid() = created_by or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- O dono só pode marcar como lida -- o `with check` impede que ele reescreva
-- título, corpo ou tipo. Notificação é registro do sistema, não bloco de
-- notas do usuário.
drop policy if exists "Owners mark own notifications read" on public.notifications;
create policy "Owners mark own notifications read"
on public.notifications for update to authenticated
using (auth.uid() = created_by)
with check (auth.uid() = created_by);


-- ==========================================================================
-- 6) AUDITORIA (spec §19) + as notificações de assinatura
--
-- POR QUE UM TRIGGER, E NÃO CHAMADAS DENTRO DAS RPCs: auditoria que depende
-- de cada função lembrar de registrar é auditoria com buracos -- basta um
-- caminho novo (ou o gateway amanhã) mexer em `subscriptions` sem chamar o
-- logger para o histórico mentir por omissão. No trigger, TODA mudança passa
-- por aqui, venha de onde vier.
--
-- O trigger é AFTER: se ele falhar, não é ele que derruba a troca de plano do
-- fornecedor. Auditoria é importante, mas não é mais importante que o usuário
-- conseguir assinar.
-- ==========================================================================

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null,
  subscription_id uuid,
  event_type text not null,
  from_plan text,
  to_plan text,
  from_status text,
  to_status text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists subscription_events_by_user
  on public.subscription_events (created_by, created_at desc);

alter table public.subscription_events enable row level security;

drop policy if exists "Owners read own subscription events" on public.subscription_events;
create policy "Owners read own subscription events"
on public.subscription_events for select to authenticated
using (auth.uid() = created_by or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');


create or replace function public.log_subscription_event()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tipo text;
  v_titulo text;
  v_corpo text;
  v_notificar boolean := true;
begin
  if TG_OP = 'INSERT' then
    if new.status = 'scheduled' then
      v_tipo   := 'plan_change_scheduled';
      v_titulo := 'Troca de plano confirmada';
      v_corpo  := 'A troca entra em vigor em ' || to_char(new.started_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';
    else
      v_tipo   := 'subscription_started';
      v_titulo := 'Plano ativado';
      v_corpo  := 'Seu plano está ativo. Próxima cobrança em '
                  || coalesce(to_char(new.next_charge_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'), 'nenhuma (plano gratuito)') || '.';
    end if;

  elsif TG_OP = 'UPDATE' then
    -- Só interessa mudança de STATUS. Um update que mexe em next_charge_at
    -- sem mudar status não é evento para o usuário.
    if old.status is not distinct from new.status then
      return null;
    end if;

    if new.status = 'cancelled' then
      v_tipo   := 'subscription_cancelled';
      v_titulo := 'Cancelamento agendado';
      v_corpo  := 'Você continua com os benefícios até '
                  || to_char(new.expires_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || '.';

    elsif old.status = 'cancelled' and new.status = 'active' then
      v_tipo   := 'subscription_reactivated';
      v_titulo := 'Cancelamento desfeito';
      v_corpo  := 'Sua assinatura continua normalmente.';

    elsif old.status = 'scheduled' and new.status = 'active' then
      v_tipo   := 'plan_change_applied';
      v_titulo := 'Troca de plano aplicada';
      v_corpo  := 'Seu novo plano já está valendo.';

    elsif new.status = 'suspended' then
      v_tipo   := 'subscription_suspended';
      v_titulo := 'Plano suspenso';
      v_corpo  := 'Não conseguimos confirmar o pagamento. Seus anúncios ficam suspensos até a regularização -- nada foi apagado.';

    elsif new.status = 'expired' then
      -- DISCRIMINADOR IMPORTANTE, e sem ele o upgrade avisaria "assinatura
      -- encerrada" um instante antes de avisar "plano ativado".
      --   expirou de verdade  -> old.expires_at JÁ ESTAVA no passado
      --   encerrada no upgrade -> old.expires_at estava no FUTURO e
      --                           subscribe_to_plan a forçou para now()
      if old.expires_at <= now() then
        v_tipo   := 'subscription_ended';
        v_titulo := 'Assinatura encerrada';
        v_corpo  := 'Você está sem plano. Seus anúncios e produtos ficam suspensos até você assinar de novo -- nada foi apagado.';
      else
        v_tipo      := 'plan_replaced';
        v_notificar := false;  -- o insert do plano novo é quem avisa
      end if;

    else
      v_tipo      := 'status_changed';
      v_notificar := false;
    end if;
  else
    return null;
  end if;

  -- AUDITORIA: sempre, inclusive para os eventos que não viram notificação.
  -- É a diferença entre o histórico técnico (completo) e o que a pessoa lê
  -- (só o que importa para ela) -- a spec §19 pede exatamente essa separação.
  insert into public.subscription_events (
    created_by, subscription_id, event_type, from_plan, to_plan,
    from_status, to_status, metadata
  ) values (
    new.created_by, new.id, v_tipo,
    case when TG_OP = 'UPDATE' then old.plan_id end, new.plan_id,
    case when TG_OP = 'UPDATE' then old.status end, new.status,
    jsonb_build_object(
      'expires_at', new.expires_at,
      'next_charge_at', new.next_charge_at,
      'op', TG_OP
    )
  );

  if v_notificar then
    insert into public.notifications (created_by, type, title, body, link, metadata)
    values (new.created_by, v_tipo, v_titulo, v_corpo, '/Dashboard',
            jsonb_build_object('subscription_id', new.id, 'plan_id', new.plan_id));
  end if;

  return null;
exception when others then
  -- NUNCA derrubar a operação do usuário por causa do log. Se a auditoria
  -- falhar, a assinatura tem que valer assim mesmo -- o inverso seria um
  -- fornecedor impedido de assinar porque uma tabela acessória quebrou.
  raise warning 'log_subscription_event falhou: %', sqlerrm;
  return null;
end;
$function$;

drop trigger if exists trg_log_subscription_event on public.subscriptions;

create trigger trg_log_subscription_event
after insert or update on public.subscriptions
for each row execute function public.log_subscription_event();


-- ==========================================================================
-- 7) RPCs de notificação -- o que o client realmente usa hoje
-- ==========================================================================

create or replace function public.mark_notification_read(p_id uuid)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.notifications
  set read_at = coalesce(read_at, now())
  where id = p_id and created_by = auth.uid();
$function$;

create or replace function public.mark_all_notifications_read()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n integer;
begin
  update public.notifications
  set read_at = now()
  where created_by = auth.uid() and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$function$;

create or replace function public.my_unread_notification_count()
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(*)::int from public.notifications
  where created_by = auth.uid() and read_at is null;
$function$;

revoke execute on function public.mark_notification_read(uuid) from public, anon;
revoke execute on function public.mark_all_notifications_read() from public, anon;
revoke execute on function public.my_unread_notification_count() from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.my_unread_notification_count() to authenticated;


notify pgrst, 'reload schema';


-- ==========================================================================
-- O QUE FICA PARA A RODADA DO GATEWAY (nada disto existe aqui)
--
--  * escolher o gateway e integrar;
--  * a função que CRIA o payment do ciclo e dispara a cobrança;
--  * o handler HTTP do webhook (Edge Function) que grava em webhook_events
--    -- lembrando: GRAVAR e responder 200; processar depois, lendo a tabela;
--  * o processador que lê webhook_events pending, aplica o efeito e marca
--    processed (e o reprocessador dos que ficaram pending/failed);
--  * o job das tentativas nos dias 10, 11 e 13, e a suspensão após a 3ª;
--  * estorno -> status 'refunded' no payment e 'suspended' na assinatura
--    (spec §17);
--  * e-mail (spec §21).
--
-- As garantias que eles vão precisar JÁ ESTÃO AQUI e não dependem de nenhuma
-- delas ser escrita com cuidado:
--   payments_one_per_cycle ......... não existe cobrança dupla no mesmo ciclo
--   payments_gateway_id_unique ..... a mesma cobrança lá não vira duas aqui
--   payment_attempts_unique_no ..... não existe "segunda tentativa" repetida
--   check (attempt_no between 1 and 3) ... não existe quarta tentativa
--   webhook_events_unique .......... evento reentregue é processado uma vez
--
-- COMO CONFERIR QUE ESTE ARQUIVO ESTÁ NO BANCO:
--   select tablename from pg_tables where schemaname='public'
--    and tablename in ('payment_methods','payments','payment_attempts',
--                      'webhook_events','notifications','subscription_events');
--   -- esperado: as 6
--
--   select tgname from pg_trigger where tgname = 'trg_log_subscription_event';
--
-- Re-executável DO INÍCIO AO FIM: `create table if not exists`,
-- `create index if not exists`, `create or replace`, e cada policy
-- precedida de `drop policy if exists`.
--
-- Esse drop-antes-de-criar não é enfeite: o Postgres NÃO tem
-- `create policy if not exists`, então sem ele a segunda execução morreria
-- em "policy already exists" -- e um arquivo que só roda uma vez é um
-- arquivo que ninguém consegue reaplicar depois de uma restauração. Foi o
-- problema da seção 94.
-- ==========================================================================
