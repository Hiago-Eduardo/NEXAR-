import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const uploadBucket = import.meta.env.VITE_SUPABASE_UPLOAD_BUCKET || 'uploads';

const tableByEntity = {
  Supplier: 'suppliers',
  Product: 'products',
  ProductImage: 'product_images',
  SupplierImage: 'supplier_images',
  SupplierProduct: 'supplier_products',
  Review: 'reviews',
  UserProfile: 'user_profiles',
  ContactRequest: 'contact_requests',
  ChatMessage: 'chat_messages',
};

/**
 * Entidades cuja tabela NAO TEM a coluna `created_by`.
 *
 * O create() generico carimba created_by em todo insert (ver la embaixo), e
 * o PostgREST RECUSA a linha inteira quando a coluna nao existe:
 *
 *     Could not find the 'created_by' column of '<tabela>' in the schema cache
 *
 * Estas tres sao tabelas de LIGACAO ou FILHAS: a propriedade delas nao e
 * propria, e derivada do pai (product_images -> products.created_by,
 * supplier_images/supplier_products -> suppliers.created_by), e e assim que
 * as policies de RLS delas resolvem dono. Acrescentar a coluna so para
 * satisfazer o carimbo criaria uma segunda fonte de verdade para a mesma
 * informacao -- exatamente o problema de suppliers.plan/verified.
 *
 * ISTO ERA UM BUG DE VERDADE, nao precaucao: enquanto esta lista nao
 * existiu, adicionar foto a um produto (Catalogo.jsx) e vincular produto a
 * um anuncio (AdEditor.jsx) falhavam SEMPRE -- desde que o catalogo foi
 * escrito. Ver CONTEXTO.MD/Resumo.md secao 141.
 */
const ENTITIES_WITHOUT_CREATED_BY = new Set([
  'ProductImage',
  'SupplierImage',
  'SupplierProduct',
]);

export const supabase = createClient(supabaseUrl, supabaseKey);

// Colunas de suppliers seguras pra ler como visitante sem login (anon).
// phone/email/website/delivery_info são de contato e ficaram com select
// revogado de anon direto na tabela (supabase/contact-info-login-gate.sql) --
// pedir '*' nesse caso falha inteiro, então qualquer leitura pública/anônima
// de suppliers (listagens, feed da home, anúncio quando deslogado) precisa
// pedir exatamente esta lista em vez de '*'. Usuário logado (authenticated)
// continua podendo pedir '*' normalmente.
export const SUPPLIER_PUBLIC_COLUMNS =
  'id,business_name,category,location,description,tags,rating,total_reviews,logo_url,cover_url,plan,status,min_order,created_at';

function assertSupabaseConfigured() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.');
  }
}

function normalizeColumn(column) {
  if (column === 'created_date') return 'created_at';
  return column;
}

function parseOrder(orderBy) {
  if (!orderBy) return null;
  const descending = orderBy.startsWith('-');
  const column = descending ? orderBy.slice(1) : orderBy;
  return {
    column: normalizeColumn(column),
    ascending: !descending,
  };
}

function normalizeFileName(name = 'upload') {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
}

async function currentSupabaseUser() {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user;
}

async function getCreatedByFilterValue(value) {
  const user = await currentSupabaseUser().catch(() => null);
  if (user?.email && value === user.email) return user.id;
  return value;
}

// ATENÇÃO AO RETORNO EMBRULHADO -- não "simplificar" para `return nextQuery`.
//
// Esta função precisa ser async (a tradução de created_by consulta a sessão),
// e o PostgrestFilterBuilder do supabase-js é um THENABLE: ele implementa
// .then() para permitir `await query`. Uma função async que retorna um
// thenable faz o JavaScript ADOTÁ-LO -- a promise chama .then() nele, o que
// EXECUTA a consulta, e resolve com o resultado `{data, error}` em vez do
// builder. Ou seja, `await applyFilters(...)` nunca devolvia um builder:
// devolvia uma consulta já executada, sem .order() nem .limit().
//
// O efeito era silencioso e assimétrico, que foi o que escondeu o bug por
// tanto tempo: filter() SEM ordenação funcionava por acidente (o objeto de
// resultado passa batido por applyOrderAndLimit e destrutura data/error
// normalmente), e filter() COM ordenação estourava
// "nextQuery.order is not a function". Ver CONTEXTO.MD/Resumo.md seção 104.
async function applyFilters(query, criteria = {}) {
  let nextQuery = query;

  for (const [key, rawValue] of Object.entries(criteria)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    const column = normalizeColumn(key);
    const value = column === 'created_by'
      ? await getCreatedByFilterValue(rawValue)
      : rawValue;

    nextQuery = nextQuery.eq(column, value);
  }

  return { query: nextQuery };
}

function applyOrderAndLimit(query, orderBy, limit) {
  let nextQuery = query;
  const order = parseOrder(orderBy);

  if (order) {
    nextQuery = nextQuery.order(order.column, { ascending: order.ascending });
  }

  if (limit) {
    nextQuery = nextQuery.limit(limit);
  }

  return nextQuery;
}

function raiseIfError(error) {
  if (error) throw error;
}

/**
 * Normaliza o retorno de uma RPC `returns <tabela>` que pode nao achar linha
 * nenhuma. USE ISTO, nunca `data || null`.
 *
 * O PORQUE: o PostgREST expande uma funcao que devolve composite com
 * `select * from f()`. Quando a funcao nao acha nada ela devolve um COMPOSITE
 * NULL, e expandir composite null com `.*` produz UMA LINHA COM TODAS AS
 * COLUNAS NULL -- nao `null`. Entao `data` chega assim:
 *
 *   { id: null, created_by: null, plan_id: null, status: null, ... }
 *
 * que e um objeto TRUTHY. `data || null` nao filtra nada e o objeto vazio
 * segue para as telas como se fosse uma assinatura de verdade.
 *
 * FOI ASSIM QUE O BUG DA SECAO 119 APARECEU: o aviso do Dashboard
 * ("Em <data> seu plano passa para <plano>") era renderizado para TODO
 * fornecedor, com os dois valores vazios, porque `{scheduled && ...}` via um
 * objeto truthy. E getSubscriptionState() classificava quem nunca assinou
 * como 'expired' em vez de 'none', porque tambem so testava `if (!subscription)`.
 *
 * Testar `id` e suficiente e e preciso: e a PK da tabela e nunca e nula numa
 * linha real. O ramo do array e defensivo -- dependendo da versao, o
 * PostgREST pode devolver a linha unica embrulhada numa lista.
 */
export function rowOrNull(data) {
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.id === null || row.id === undefined) return null;
  return row;
}

function createEntityClient(entityName) {
  const table = tableByEntity[entityName];

  if (!table) {
    throw new Error(`No Supabase table mapped for entity "${entityName}".`);
  }

  return {
    async listForCurrentUser(orderBy, limit) {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user?.email) return [];

      // Pela CONTA (sender_user_id/receiver_user_id, supabase/chat-by-account.sql)
      // e, para mensagens antigas, pelo e-mail. Só pelo e-mail, a conversa de
      // anúncio não aparecia para o dono: o destino dela é o id do anúncio.
      const email = user.email.replace(/([,()])/g, "\\$1");
      const query = applyOrderAndLimit(
        supabase.from(table).select('*').or(
          `sender_user_id.eq.${user.id},receiver_user_id.eq.${user.id},sender_id.ilike.${email},receiver_id.ilike.${email}`
        ),
        orderBy,
        limit
      );
      const { data, error } = await query;
      raiseIfError(error);
      return data || [];
    },

    // `columns` (opcional): lista explícita de colunas em vez de '*'. Necessário pra
    // ler suppliers como anon depois do revoke por coluna em
    // supabase/contact-info-login-gate.sql -- select('*') falha inteiro (não retorna
    // null nas colunas restritas) se a role não tiver select numa delas.
    async list(orderBy, limit, columns = '*') {
      assertSupabaseConfigured();
      const query = applyOrderAndLimit(supabase.from(table).select(columns), orderBy, limit);
      const { data, error } = await query;
      raiseIfError(error);
      return data || [];
    },

    async filter(criteria = {}, orderBy, limit, columns = '*') {
      assertSupabaseConfigured();
      const { query: filteredQuery } = await applyFilters(
        supabase.from(table).select(columns),
        criteria
      );
      const query = applyOrderAndLimit(filteredQuery, orderBy, limit);
      const { data, error } = await query;
      raiseIfError(error);
      return data || [];
    },

    // Contagem via HEAD request (sem baixar linhas) -- usado pra estatísticas
    // públicas (ex: nº de fornecedores/avaliações no Hero da Home). `criteria`
    // aceita os mesmos filtros de equality de `filter()`.
    async count(criteria = {}) {
      assertSupabaseConfigured();
      const { query: filteredQuery } = await applyFilters(
        supabase.from(table).select('id', { count: 'exact', head: true }),
        criteria
      );
      const { count, error } = await filteredQuery;
      raiseIfError(error);
      return count || 0;
    },

    async create(data) {
      assertSupabaseConfigured();
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (!sessionData.session?.user) {
        throw new Error('Você precisa estar autenticado para criar este registro.');
      }
      // A sessao continua sendo exigida acima mesmo para as tabelas sem
      // created_by: elas tambem so aceitam escrita de usuario logado (as
      // policies checam auth.uid() atraves do pai), entao barrar aqui troca
      // um erro cru do Postgres por uma mensagem em portugues.
      const payload = ENTITIES_WITHOUT_CREATED_BY.has(entityName)
        ? { ...data }
        : { ...data, created_by: sessionData.session.user.id };
      const { data: created, error } = await supabase
        .from(table)
        .insert(payload)
        .select('*')
        .single();

      raiseIfError(error);
      return created;
    },

    async update(id, data) {
      assertSupabaseConfigured();
      const { data: updated, error } = await supabase
        .from(table)
        .update(data)
        .eq('id', id)
        .select('*')
        .single();

      raiseIfError(error);
      return updated;
    },

    async delete(id) {
      assertSupabaseConfigured();
      const { error } = await supabase
        .from(table)
        .delete()
        .eq('id', id);

      raiseIfError(error);
      return true;
    },
  };
}

async function uploadFile({ file }) {
  assertSupabaseConfigured();

  if (!file) {
    throw new Error('UploadFile requires a file.');
  }

  const safeName = normalizeFileName(file.name);
  const path = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;

  const { error } = await supabase.storage
    .from(uploadBucket)
    .upload(path, file, { upsert: false });

  raiseIfError(error);

  const { data } = supabase.storage
    .from(uploadBucket)
    .getPublicUrl(path);

  return { file_url: data.publicUrl };
}

function toAppUser(user) {
  const role = user.user_metadata?.role || user.user_metadata?.user_type || user.app_metadata?.role || 'user';
  return {
    id: user.id,
    email: user.email,
    full_name: user.user_metadata?.full_name || user.email,
    role,
    active_plan: user.user_metadata?.active_plan || null,
  };
}

export const api = {
  entities: Object.fromEntries(
    Object.keys(tableByEntity).map((entityName) => [entityName, createEntityClient(entityName)])
  ),
  integrations: {
    Core: {
      UploadFile: uploadFile,
    },
  },
  subscriptions: {
    // Ver rowOrNull() -- NAO trocar por `data || null`.
    // Assinatura mais recente do fornecedor (pode estar ativa, cancelada dentro da
    // carencia, ou expirada) -- fonte da verdade e a tabela `subscriptions`, nunca
    // user_metadata nem um campo solto em user_profiles.
    // Via RPC (my_current_subscription) e nao mais por select direto: com a
    // introducao das assinaturas AGENDADAS (status 'scheduled', started_at no
    // futuro -- ver supabase/subscription-plan-change.sql), o
    // "order by started_at desc limit 1" antigo passaria a devolver a
    // agendada como se fosse a atual. A RPC exclui 'scheduled' na origem.
    async getCurrent() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return null;

      const { data, error } = await supabase.rpc('my_current_subscription');
      raiseIfError(error);
      return rowOrNull(data);
    },

    // Troca de plano ja contratada que ainda nao entrou em vigor (downgrade
    // agendado para o fim do ciclo atual). null quando nao ha nenhuma.
    async getScheduled() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return null;

      const { data, error } = await supabase.rpc('my_scheduled_subscription');
      raiseIfError(error);
      return rowOrNull(data);
    },

    async cancelScheduledChange() {
      assertSupabaseConfigured();
      const { error } = await supabase.rpc('cancel_scheduled_plan_change');
      raiseIfError(error);
    },

    async getHistory() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('created_by', user.id)
        .order('started_at', { ascending: false });

      raiseIfError(error);
      return data || [];
    },

    // As datas (started_at/expires_at) sao sempre calculadas no banco por essa RPC --
    // o cliente so escolhe o plano, nunca envia ou altera prazos diretamente.
    async subscribe(planId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('subscribe_to_plan', { p_plan_id: planId });
      raiseIfError(error);
      return data;
    },

    async cancel() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('cancel_my_subscription');
      raiseIfError(error);
      return data;
    },

    async reactivate() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('reactivate_my_subscription');
      raiseIfError(error);
      return data;
    },

    // Reconcilia expiracao (idempotente): marca assinaturas vencidas como expiradas e
    // pausa os anuncios que estavam ativos. Chamar ao carregar telas de plano/anuncios.
    async sync() {
      assertSupabaseConfigured();
      const { error } = await supabase.rpc('sync_my_subscription');
      raiseIfError(error);
    },

    // Auditoria da assinatura (supabase/payments-audit-notifications.sql).
    // Escrita por TRIGGER, nunca pelo client -- quem chama isto so le. E o
    // historico TECNICO: inclui eventos que nao viraram notificacao, como o
    // 'plan_replaced' de um upgrade.
    async getEvents(limit = 50) {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from('subscription_events')
        .select('*')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      raiseIfError(error);
      return data || [];
    },
  },

  // Checkout Asaas (supabase/functions/billing-checkout, §232). O navegador
  // so manda o plano escolhido; preco, conta e periodo saem do banco. Devolve
  // o link da fatura do Asaas -- abrir/pagar NAO ativa nada: so o webhook
  // ativa, depois que o Asaas confirma. Chave da API nunca passa por aqui.
  billing: {
    async startCheckout(planId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.functions.invoke('billing-checkout', { body: { plan_id: planId } });
      if (error) {
        // So o CODIGO e o status saem daqui; o texto da tela vem de
        // checkoutFeedback() em plans.js (nunca a mensagem crua).
        let checkoutCode = null;
        let httpStatus = 0;
        try {
          httpStatus = Number(error.context?.status ?? 0);
          checkoutCode = (await error.context?.json?.())?.error ?? null;
        } catch { /* sem corpo (rede) */ }
        const e = new Error('checkout_failed');
        e.checkoutCode = checkoutCode;
        e.httpStatus = httpStatus;
        throw e;
      }
      if (!data?.invoiceUrl) throw new Error('checkout_failed');
      // §237: pix/boleto para pagar dentro do NEXAR (null se indisponível);
      // paymentId é o id LOCAL, usado para acompanhar o status.
      return { invoiceUrl: data.invoiceUrl, reused: data.reused === true, paymentId: data.paymentId ?? null,
        amountCents: data.amountCents ?? null, dueDate: data.dueDate ?? null,
        pix: data.pix ?? null, boleto: data.boleto ?? null };
    },
    // Cartão digitado no NEXAR (§240): vai direto para a Edge Function, que
    // repassa ao Asaas. Nada do cartão é guardado no navegador nem no banco.
    async payWithCard(planId, card, holder) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.functions.invoke('billing-checkout', {
        body: { plan_id: planId, method: 'card', card, holder },
      });
      if (error) {
        let checkoutCode = null;
        let httpStatus = 0;
        try {
          httpStatus = Number(error.context?.status ?? 0);
          checkoutCode = (await error.context?.json?.())?.error ?? null;
        } catch { /* sem corpo (rede) */ }
        const e = new Error('card_failed');
        e.checkoutCode = checkoutCode;
        e.httpStatus = httpStatus;
        throw e;
      }
      return data;
    },
    // Status da própria cobrança (RLS "Owners read own payments").
    async getPaymentStatus(paymentId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.from('payments')
        .select('id, status, consumed_at, unapplied_reason, gateway_status')
        .eq('id', paymentId).maybeSingle();
      if (error) throw error;
      return data;
    },
  },

  // Historico financeiro. Hoje SEMPRE VAZIO: nao existe gateway, entao
  // ninguem escreve em payments. Existe para a tela ja saber ler quando
  // existir, e para a estrutura ser exercitavel antes da integracao.
  payments: {
    async getHistory(limit = 24) {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('created_by', user.id)
        .order('billing_cycle', { ascending: false })
        .limit(limit);

      raiseIfError(error);
      return data || [];
    },

    // As tentativas de UM pagamento (dias 10, 11 e 13 -- no maximo tres).
    async getAttempts(paymentId) {
      assertSupabaseConfigured();
      if (!paymentId) return [];

      const { data, error } = await supabase
        .from('payment_attempts')
        .select('*')
        .eq('payment_id', paymentId)
        .order('attempt_no', { ascending: true });

      raiseIfError(error);
      return data || [];
    },

    // Metodos salvos. So leitura e exclusao: cadastrar passa pela
    // tokenizacao do gateway, nao por insert do client -- por isso nao ha
    // policy de INSERT na tabela.
    async listMethods() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from('payment_methods')
        .select('*')
        .eq('created_by', user.id)
        .is('deleted_at', null)
        .order('is_default', { ascending: false });

      raiseIfError(error);
      return data || [];
    },

    async removeMethod(id) {
      assertSupabaseConfigured();
      const { error } = await supabase.from('payment_methods').delete().eq('id', id);
      raiseIfError(error);
    },
  },

  notifications: {
    async list(limit = 50) {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return [];

      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('created_by', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      raiseIfError(error);
      return data || [];
    },

    async unreadCount() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return 0;

      const { data, error } = await supabase.rpc('my_unread_notification_count');
      raiseIfError(error);
      return data ?? 0;
    },

    async markRead(id) {
      assertSupabaseConfigured();
      const { error } = await supabase.rpc('mark_notification_read', { p_id: id });
      raiseIfError(error);
    },

    async markAllRead() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('mark_all_notifications_read');
      raiseIfError(error);
      return data ?? 0;
    },
  },

  // Leitura de mensagens do chat (supabase/chat-read-receipts.sql). RPC e não
  // update direto porque a policy de update de chat_messages é só do
  // REMETENTE -- quem marca como lida é o destinatário.
  // Status do pedido de orçamento, pelo DONO DO ANÚNCIO
  // (supabase/contact-request-status.sql). RPC porque a policy de update de
  // contact_requests só aceita quem enviou o pedido.
  // Limites de plano do lado do fornecedor (supabase/plan-limits-ux.sql).
  // previewChange: o que sai e o que volta ao ar se a conta passar a ter
  // `planId` (null = sem plano, o cancelamento). Só leitura.
  // swap: põe no ar um item suspenso pelo limite no lugar de um ativo, numa
  // operação só no banco -- o limite nunca é passado.
  planLimits: {
    async previewChange(planId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('preview_my_plan_change', { p_plan_id: planId ?? null });
      raiseIfError(error);
      return data;
    },

    async swap(kind, activateId, suspendId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('swap_plan_slot', {
        p_kind: kind, p_activate: activateId, p_suspend: suspendId,
      });
      raiseIfError(error);
      return data;
    },
  },

  contactRequests: {
    // Pedido de orçamento pela Edge Function submit-contact-request, que
    // confere o Turnstile e grava (§228). Só usado com
    // VITE_TURNSTILE_CONTACT_REQUIRED=true; sem isso o formulário segue no
    // insert direto de sempre.
    async submit({ supplierId, sender_name, sender_email, sender_phone, message, captchaToken }) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.functions.invoke('submit-contact-request', {
        body: { supplier_id: supplierId, sender_name, sender_email, sender_phone, message, captchaToken },
      });
      if (error) {
        // Erro HTTP da função: a mensagem útil está no corpo JSON.
        let corpo = null;
        try {
          corpo = await error.context?.json?.();
        } catch {
          corpo = null;
        }
        const err = new Error(corpo?.message || 'Não foi possível enviar o pedido. Tente de novo.');
        err.code = corpo?.error || 'request_failed';
        err.reason = corpo?.reason || null;
        throw err;
      }
      return data;
    },

    async setStatus(id, status) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('set_contact_request_status', { p_id: id, p_status: status });
      raiseIfError(error);
      return data;
    },
  },

  chat: {
    async unreadCount() {
      assertSupabaseConfigured();
      const user = await currentSupabaseUser();
      if (!user) return 0;

      const { data, error } = await supabase.rpc('my_unread_message_count');
      raiseIfError(error);
      return data ?? 0;
    },

    async markConversationRead(conversationId) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('mark_conversation_read', { p_conversation_id: conversationId });
      raiseIfError(error);
      return data ?? 0;
    },

    async markAllRead() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('mark_all_messages_read');
      raiseIfError(error);
      return data ?? 0;
    },
  },

  verification: {
    // Selo "Verificado" publico: representa o plano Premium usavel do DONO do
    // anuncio (nunca do usuario logado que esta vendo a pagina). Calculado no
    // banco via RPC security definer (suppliers_verified_status, em
    // supabase/rls-policies.sql) para nao expor a tabela subscriptions
    // (privada) a quem nao e o dono -- so devolve um boolean por fornecedor.
    async getForSuppliers(supplierIds) {
      assertSupabaseConfigured();
      const ids = [...new Set((supplierIds || []).filter(Boolean))];
      if (!ids.length) return {};

      const { data, error } = await supabase.rpc('suppliers_verified_status', {
        p_supplier_ids: ids,
      });
      raiseIfError(error);
      return Object.fromEntries((data || []).map((row) => [row.supplier_id, row.is_verified]));
    },
  },
  // ------------------------------------------------------------------------
  // Vitrine publica de anuncios.
  //
  // Desde supabase/anon-content-gate.sql a tabela `suppliers` NAO e mais
  // legivel diretamente por visitante sem conta -- a listagem passa por estas
  // RPCs, que filtram no banco e cortam o resultado em anon_preview_limit()
  // quando nao ha sessao. A busca continua livre; o que e limitado e quanto
  // se ve. Ver CONTEXTO.MD/Resumo.md secao 84.
  // ------------------------------------------------------------------------
  catalog: {
    // Teto da amostra do visitante, lido do BANCO (anon_preview_limit()) em vez
    // de repetido como constante aqui. A tela precisa do numero para dizer
    // honestamente que esta mostrando uma amostra; duplicar o 8 no client
    // criaria duas fontes de verdade que silenciosamente divergem no dia em que
    // o limite mudar no SQL. Ver CONTEXTO.MD/Resumo.md secao 96.
    async previewLimit() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('anon_preview_limit');
      raiseIfError(error);
      return typeof data === 'number' ? data : 8;
    },

    async listSuppliers({ search = "", category = "", city = "", limit = 200 } = {}) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('suppliers_public_list', {
        p_search: search || null,
        p_category: category || null,
        p_city: city || null,
        p_limit: limit,
      });
      raiseIfError(error);
      return data || [];
    },

    // Total REAL de anuncios que casam com o filtro -- devolvido tambem para
    // o visitante, para a tela poder dizer "mostrando 8 de 47".
    async countSuppliers({ search = "", category = "", city = "" } = {}) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('suppliers_public_count', {
        p_search: search || null,
        p_category: category || null,
        p_city: city || null,
      });
      raiseIfError(error);
      return data || 0;
    },

    // Quantos anuncios ativos existem em cada categoria, numa chamada so
    // (ver supabase/category-counts-rpc.sql). Usado pelo grid da Home para
    // mostrar onde ha oferta em vez de listar dez categorias iguais, sendo
    // que a maioria pode estar vazia. Devolve um objeto { categoria: total }.
    async countByCategory() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('suppliers_count_by_category');
      raiseIfError(error);
      return Object.fromEntries((data || []).map((row) => [row.category, row.total]));
    },

    // Anuncio individual para quem NAO tem conta (segue aberto, e a isca).
    // Quem tem conta le a tabela direto com '*' e recebe tambem os campos de
    // contato -- ver SupplierProfile.jsx.
    async getSupplierById(supplierId) {
      assertSupabaseConfigured();
      if (!supplierId) return null;
      const { data, error } = await supabase.rpc('supplier_public_by_id', { p_id: supplierId });
      raiseIfError(error);
      return (data && data[0]) || null;
    },
  },

  company: {
    // Dados comerciais da EMPRESA dona de um anuncio (nunca full_name/email/
    // plano/created_by). RPC security definer resolve o dono internamente a
    // partir do supplier_id -- ver company_public_profile em
    // supabase/company-profile-rpc.sql.
    //
    // ATENCAO: getPublicProfile/getPublicSuppliers/getPublicProducts e o
    // search por empresa deixaram de ser executaveis por `anon`
    // (anon-content-gate.sql). Chamar sem sessao devolve erro de permissao --
    // as telas precisam checar login ANTES de chamar.
    async getPublicProfile(supplierId) {
      assertSupabaseConfigured();
      if (!supplierId) return null;
      const { data, error } = await supabase.rpc('company_public_profile', {
        p_supplier_id: supplierId,
      });
      raiseIfError(error);
      return data?.[0] || null;
    },

    // Todos os anuncios ATIVOS da mesma empresa (mesmo created_by), incluindo
    // o anuncio de origem se ele estiver ativo. Ver company_public_suppliers.
    async getPublicSuppliers(supplierId) {
      assertSupabaseConfigured();
      if (!supplierId) return [];
      const { data, error } = await supabase.rpc('company_public_suppliers', {
        p_supplier_id: supplierId,
      });
      raiseIfError(error);
      return data || [];
    },

    // Catálogo de produtos da EMPRESA dona de um anúncio (mesmo created_by
    // do anúncio, nunca por anúncio individual -- ver
    // CONTEXTO.MD/Resumo.md seções 66-67 e supabase/product-catalog.sql).
    // RPC security definer resolve o dono internamente a partir do
    // supplier_id, mesma técnica de company_public_suppliers -- o cliente
    // nunca precisa (nem pode) filtrar produtos pelo created_by cru de
    // outra conta. Imagens já vêm agregadas (jsonb) dentro de cada linha.
    async getPublicProducts(supplierId) {
      assertSupabaseConfigured();
      if (!supplierId) return [];
      const { data, error } = await supabase.rpc('company_public_products', {
        p_supplier_id: supplierId,
      });
      raiseIfError(error);
      return data || [];
    },

    // Busca de empresas (uma linha por empresa, agregando os anúncios ativos
    // dela) para a aba "Empresas" de Suppliers.jsx. RPC security definer
    // (company_search_public, supabase/company-search-rpc.sql) -- mesmo
    // motivo de company_public_profile: juntar user_profiles (privado) aos
    // anúncios sem expor full_name/email/cnpj/subscriptions.
    async search({ search = '', category = '', city = '', limit = 50, offset = 0 } = {}) {
      assertSupabaseConfigured();
      // company_search_preview e nao _public: o invólucro fixa o teto de
      // resultados com base em auth.uid(), em vez de confiar no p_limit
      // enviado pelo cliente (que seria trivialmente burlável).
      const { data, error } = await supabase.rpc('company_search_preview', {
        p_search: search || null,
        p_category: category || null,
        p_city: city || null,
        p_limit: limit,
        p_offset: offset,
      });
      raiseIfError(error);
      return data || [];
    },
  },
  metrics: {
    // Registra uma visualização real da página pública do anúncio. Deduplicação (1 por
    // visitante por anúncio por dia) e a exclusão do próprio dono acontecem no banco
    // (register_ad_view em supabase/rls-policies.sql) — o frontend só manifesta a intenção.
    async registerView(supplierId, sessionId) {
      assertSupabaseConfigured();
      const { error } = await supabase.rpc('register_ad_view', {
        p_supplier_id: supplierId,
        p_session_id: sessionId || null,
      });
      raiseIfError(error);
    },

    async getMyAdViewCounts() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('my_ad_view_counts');
      raiseIfError(error);
      return data || [];
    },

    async getMyLeadCounts() {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('my_lead_counts');
      raiseIfError(error);
      return data || [];
    },

    async getMyDailyStats(days = 30) {
      assertSupabaseConfigured();
      const { data, error } = await supabase.rpc('my_daily_stats', { p_days: days });
      raiseIfError(error);
      return data || [];
    },
  },
  auth: {
    async me() {
      const user = await currentSupabaseUser();

      if (!user) {
        const error = new Error('Not authenticated');
        error.status = 401;
        throw error;
      }

      return toAppUser(user);
    },

    async logout(redirectTo) {
      assertSupabaseConfigured();
      await supabase.auth.signOut();

      if (redirectTo && typeof window !== 'undefined') {
        window.location.href = redirectTo;
      }
    },

    redirectToLogin(returnTo) {
      if (typeof window === 'undefined') return;

      // /Login, não /Register (seção 161). Quem cai aqui está tentando abrir
      // uma página de conta -- na maioria das vezes JÁ TEM conta e a sessão
      // expirou. Antes caía em "Criar Conta", sem link para entrar, e o
      // ?from= era ignorado. O Login tem link para o cadastro e repassa o from.
      const target = new URL('/Login', window.location.origin);
      if (returnTo) target.searchParams.set('from', returnTo);
      window.location.href = target.toString();
    },
  },
};
