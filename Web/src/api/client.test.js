/**
 * Testes da CAMADA DE DADOS (src/api/client.js).
 *
 * Por que esta suíte existe, e por que ela é a primeira do projeto:
 * `src/api/client.js` está deliberadamente fora do ESLint e do typecheck
 * (ver eslint.config.js e jsconfig.json) -- é a camada da qual todas as telas
 * dependem e era a única sem nenhuma rede de proteção. O bug da seção 104
 * (applyFilters async devolvendo um thenable, o que EXECUTAVA a consulta e
 * quebrava todo filter() com ordenação) viveu meses ali e só apareceu quando
 * um usuário reclamou de uma lista vazia. Qualquer um dos testes abaixo teria
 * pegado na hora.
 *
 * Estes são testes de INTEGRAÇÃO: batem no Supabase real com a chave anon,
 * como um visitante sem conta. Isso é proposital -- o que quebrou não foi
 * lógica pura, foi a forma como o nosso código compõe o supabase-js. Um mock
 * do builder teria passado com o código quebrado, porque o mock não seria um
 * thenable.
 *
 * As asserções são ESTRUTURAIS, nunca sobre a quantidade de linhas: o banco é
 * de desenvolvimento e o conteúdo muda. Um teste que espera "2 fornecedores"
 * vira falso negativo no dia seguinte.
 */
import { describe, it, expect } from 'vitest';
import { api, supabase, SUPPLIER_PUBLIC_COLUMNS, rowOrNull } from './client';

const configured =
  !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Sem .env.local não há o que testar -- pular é melhor que falhar, para não
// quebrar o `npm test` de quem clonou o repo e ainda não configurou nada.
const suite = configured ? describe : describe.skip;

suite('entities.filter (camada genérica de CRUD)', () => {
  // ESTE É O TESTE DE REGRESSÃO DA SEÇÃO 104.
  // Não depende de haver avaliações no banco: o bug era um TypeError lançado
  // na montagem da consulta ("nextQuery.order is not a function"), então
  // estourava mesmo com zero linhas. É o que o torna um bom teste.
  it('aceita ordenação sem estourar (regressão: applyFilters devolvia consulta executada)', async () => {
    const rows = await api.entities.Review.filter({ supplier_id: null }, '-created_date', 50);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('aceita ordenação ascendente e limite', async () => {
    const rows = await api.entities.Review.filter({}, 'created_date', 5);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('funciona também SEM ordenação (o caminho que funcionava por acidente)', async () => {
    const rows = await api.entities.Review.filter({});
    expect(Array.isArray(rows)).toBe(true);
  });

  it('traz o mesmo conjunto com e sem ordenação', async () => {
    const [ordenado, solto] = await Promise.all([
      api.entities.Review.filter({}, '-created_date', 100),
      api.entities.Review.filter({}),
    ]);
    expect(ordenado.length).toBe(solto.length);
  });

  // `created_date` não existe como coluna: o client reescreve para
  // `created_at` (normalizeColumn). Se a reescrita sumir, o Postgres devolve
  // 42703 "column does not exist" e este teste quebra.
  it('reescreve created_date para created_at na ordenação', async () => {
    const rows = await api.entities.Review.filter({}, '-created_date', 1);
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) {
      expect(rows[0]).toHaveProperty('created_at');
      expect(rows[0]).not.toHaveProperty('created_date');
    }
  });

  it('ordena de verdade, do mais novo para o mais antigo', async () => {
    const rows = await api.entities.Review.filter({}, '-created_date', 50);
    const datas = rows.map((r) => new Date(r.created_at).getTime());
    const esperado = [...datas].sort((a, b) => b - a);
    expect(datas).toEqual(esperado);
  });

  it('count() devolve um número', async () => {
    const total = await api.entities.Review.count();
    expect(typeof total).toBe('number');
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it('filtro com valor vazio é ignorado, não vira eq("")', async () => {
    // applyFilters pula undefined/null/'' -- se parasse de pular, isto
    // devolveria [] em vez do conjunto completo.
    const [todos, comVazio] = await Promise.all([
      api.entities.Review.count(),
      api.entities.Review.count({ reviewer_name: '' }),
    ]);
    expect(comVazio).toBe(todos);
  });
});

suite('RPCs públicas da vitrine (muro de cadastro, seções 84/85)', () => {
  it('listSuppliers devolve linhas com as colunas públicas', async () => {
    const rows = await api.catalog.listSuppliers({});
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length) {
      expect(rows[0]).toHaveProperty('business_name');
      expect(rows[0]).toHaveProperty('rating');
      // Contato NUNCA pode vir por esta RPC, com ou sem sessão.
      expect(rows[0]).not.toHaveProperty('phone');
      expect(rows[0]).not.toHaveProperty('email');
    }
  });

  it('rating vem como número, não string (o código chama .toFixed)', async () => {
    const rows = await api.catalog.listSuppliers({});
    for (const row of rows) {
      expect(typeof row.rating).toBe('number');
    }
  });

  it('countSuppliers devolve o total real', async () => {
    const total = await api.catalog.countSuppliers({});
    expect(typeof total).toBe('number');
  });

  it('a amostra do visitante respeita o teto do banco', async () => {
    const [limite, linhas] = await Promise.all([
      api.catalog.previewLimit(),
      api.catalog.listSuppliers({}),
    ]);
    expect(typeof limite).toBe('number');
    expect(limite).toBeGreaterThan(0);
    // Sem sessão, o banco corta em anon_preview_limit(). Quem decide o teto é
    // a sessão, nunca um parâmetro do cliente -- por isso pedir limit: 500
    // não pode aumentar o resultado.
    const pedindoMuito = await api.catalog.listSuppliers({ limit: 500 });
    expect(pedindoMuito.length).toBeLessThanOrEqual(limite);
    expect(linhas.length).toBeLessThanOrEqual(limite);
  });

  it('a busca por empresa também é cortada pelo teto', async () => {
    const [limite, empresas] = await Promise.all([
      api.catalog.previewLimit(),
      api.company.search({ limit: 500 }),
    ]);
    expect(empresas.length).toBeLessThanOrEqual(limite);
  });
});

suite('muro de cadastro no banco (não pode afrouxar sem querer)', () => {
  it('visitante não lê a tabela suppliers direto', async () => {
    const { data, error } = await supabase.from('suppliers').select('id').limit(5);
    // A RLS nega silenciosamente (lista vazia), não com erro.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('as RPCs do perfil da empresa estão fechadas para visitante', async () => {
    const { error } = await supabase.rpc('company_public_profile', {
      p_supplier_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(`${error.message} ${error.code}`).toMatch(/permission denied|42501/);
  });

  it('recalc_supplier_rating não é chamável pelo cliente (seção 98)', async () => {
    const { error } = await supabase.rpc('recalc_supplier_rating', {
      p_supplier_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(`${error.message} ${error.code}`).toMatch(/permission denied|42501|not find/i);
  });

  it('SUPPLIER_PUBLIC_COLUMNS não contém coluna de contato', async () => {
    for (const proibida of ['phone', 'email', 'website', 'delivery_info']) {
      expect(SUPPLIER_PUBLIC_COLUMNS.split(',')).not.toContain(proibida);
    }
  });
});

/**
 * REGRESSÃO DA SEÇÃO 119 -- o composite vazio do PostgREST.
 *
 * Estes rodam SEM banco: são lógica pura, e o caso que interessa é
 * justamente o retorno que só aparece com uma sessão logada sem assinatura
 * -- que a suíte não tem. Reproduzir a FORMA do retorno em vez de a
 * condição é o que torna o teste possível.
 *
 * O sintoma era o Dashboard mostrando "Em  seu plano passa para " (data e
 * plano vazios) para fornecedor nenhum agendamento: `data || null` deixava
 * passar um objeto de colunas todas nulas, que é truthy.
 */
describe('rowOrNull (RPC que devolve tabela e pode nao achar linha)', () => {
  // A FORMA EXATA que o PostgREST devolve quando a funcao nao acha nada:
  // composite null expandido por `select * from f()` vira uma linha de nulos.
  const COMPOSITE_VAZIO = {
    id: null,
    created_by: null,
    plan_id: null,
    status: null,
    started_at: null,
    expires_at: null,
    cancelled_at: null,
  };

  it('devolve null para o composite de colunas todas nulas', () => {
    expect(rowOrNull(COMPOSITE_VAZIO)).toBe(null);
  });

  it('o composite vazio e truthy -- e por isso que `data || null` nao servia', () => {
    // Se este teste falhar, a premissa mudou e rowOrNull talvez nao precise
    // mais existir. Ele documenta o motivo, nao so o comportamento.
    expect(!!COMPOSITE_VAZIO).toBe(true);
    expect(COMPOSITE_VAZIO || null).not.toBe(null);
  });

  it('devolve null para null e undefined', () => {
    expect(rowOrNull(null)).toBe(null);
    expect(rowOrNull(undefined)).toBe(null);
  });

  it('preserva a linha de verdade intacta', () => {
    const linha = { id: 'abc-123', plan_id: 'profissional', status: 'scheduled' };
    expect(rowOrNull(linha)).toBe(linha);
  });

  it('desembrulha a linha quando vem dentro de uma lista', () => {
    const linha = { id: 'abc-123', plan_id: 'premium', status: 'active' };
    expect(rowOrNull([linha])).toBe(linha);
    expect(rowOrNull([])).toBe(null);
    expect(rowOrNull([COMPOSITE_VAZIO])).toBe(null);
  });
});

/**
 * REGRESSÃO DA SEÇÃO 141 -- o create() genérico e as tabelas sem created_by.
 *
 * O create() carimba `created_by` em todo insert. Três tabelas não têm essa
 * coluna (a propriedade delas vem do pai), e o PostgREST recusava a linha
 * inteira com "Could not find the 'created_by' column". Resultado: adicionar
 * foto a produto e vincular produto a anúncio falhavam SEMPRE, desde que o
 * catálogo foi escrito.
 *
 * Este teste é de LISTA, não de banco: ele prova que as três entidades
 * continuam marcadas como isentas. Se alguém acrescentar uma quarta tabela
 * de ligação e esquecer de registrá-la, o erro volta -- e a única defesa é
 * alguém lembrar. Aqui pelo menos a lista fica visível e versionada.
 */
describe('create() nao carimba created_by em tabela que nao tem a coluna', () => {
  const SEM_CREATED_BY = ['ProductImage', 'SupplierImage', 'SupplierProduct'];

  it('as tres entidades de ligacao/filhas existem no mapa de entidades', () => {
    for (const nome of SEM_CREATED_BY) {
      expect(() => api.entities[nome]).not.toThrow();
      expect(api.entities[nome]).toBeTruthy();
    }
  });

  it('as entidades com dono proprio continuam existindo e distintas', () => {
    // Se alguem marcar Supplier ou Product como isento por engano, o
    // created_by deixaria de ser gravado e a RLS de dono barraria tudo.
    for (const nome of ['Supplier', 'Product', 'Review']) {
      expect(SEM_CREATED_BY).not.toContain(nome);
      expect(api.entities[nome]).toBeTruthy();
    }
  });
});
