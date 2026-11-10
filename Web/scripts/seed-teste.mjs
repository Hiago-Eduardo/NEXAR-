/**
 * SEED DOS DADOS DE TESTE -- um anúncio e uma avaliação para a conta de
 * fornecedor de teste.
 *
 * POR QUE EXISTE: a conta testerclaude@tester.com nasceu vazia, e com isso o
 * teste `o Dashboard mostra as avaliações recebidas` (avaliacoes.spec.js)
 * passou a PULAR por falta de dado em vez de testar (seção 128). Um teste que
 * pula para sempre é um teste que não existe. Este script cria o mínimo para
 * ele voltar a rodar de verdade.
 *
 *   npm run seed           -- cria (idempotente)
 *   npm run seed:limpar    -- remove o que este script criou
 *
 * ---------------------------------------------------------------------------
 * A LIMPEZA também remove os produtos do Catálogo que estavam vinculados ao
 * anúncio [TESTE] e a nenhum outro (seção 158) -- os produtos pertencem à
 * conta e não saíam com o anúncio. Arquivos enviados ao Storage NÃO são
 * apagados: o bucket é um só para o site inteiro.
 *
 * ESTE SCRIPT ESCREVE NO BANCO DE DESENVOLVIMENTO, QUE É COMPARTILHADO.
 *
 * Por isso exige o flag --confirmo, que os npm scripts acima já passam. É um
 * flag e não uma variável de ambiente porque `VAR=1 node ...` não funciona no
 * PowerShell, e este projeto é desenvolvido no Windows -- a alternativa seria
 * uma dependência (cross-env) para resolver algo que um argv resolve.
 *
 * A regra da suíte e2e é LER, não escrever (e2e/helpers.js), justamente porque
 * lixo gravado aqui não some com um `truncate` no fim. Este script é a exceção
 * consciente: ele escreve, mas só o que sabe desfazer.
 *
 * O ANÚNCIO CRIADO É PÚBLICO. Ele aparece na vitrine do site de
 * desenvolvimento como qualquer outro, e por isso o nome começa com [TESTE]
 * -- quem abrir a listagem precisa saber, na primeira olhada, que aquilo não é
 * uma empresa real. O mesmo marcador é o que torna o script idempotente e
 * permite a limpeza: é assim que ele reconhece o que é dele.
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const MARCADOR = '[TESTE]';
const NOME_ANUNCIO = `${MARCADOR} Fornecedor de Teste Automatizado`;

function lerEnv() {
  const arquivo = path.resolve(process.cwd(), '.env.local');
  const out = {};
  if (!fs.existsSync(arquivo)) return out;
  for (const linha of fs.readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = { ...lerEnv(), ...process.env };
const limpar = process.argv.includes('--limpar');

if (!process.argv.includes('--confirmo')) {
  console.error(
    'Recusado: este script ESCREVE no banco de desenvolvimento compartilhado.\n' +
    'Rode por `npm run seed` (ou `npm run seed:limpar`), que passam --confirmo.'
  );
  process.exit(1);
}

const faltando = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY',
  'TEST_FORNECEDOR_EMAIL', 'TEST_FORNECEDOR_PASSWORD',
  'TEST_CLIENTE_EMAIL', 'TEST_CLIENTE_PASSWORD'].filter((k) => !env[k]);
if (faltando.length) {
  console.error('Faltam variáveis no .env.local: ' + faltando.join(', '));
  process.exit(1);
}

const novoCliente = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);

async function entrar(papel) {
  // Um client POR PAPEL, não um só reusado com signOut/signIn no meio: o
  // supabase-js guarda a sessão no próprio objeto, e alternar sessão numa
  // instância compartilhada produz escrita com o created_by errado -- que aqui
  // significaria a avaliação nascer com o dono do anúncio e bater no trigger
  // enforce_review_rules (SELF_REVIEW_NOT_ALLOWED).
  const sb = novoCliente();
  const email = papel === 'fornecedor' ? env.TEST_FORNECEDOR_EMAIL : env.TEST_CLIENTE_EMAIL;
  const senha = papel === 'fornecedor' ? env.TEST_FORNECEDOR_PASSWORD : env.TEST_CLIENTE_PASSWORD;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(`login de ${papel} (${email}) falhou: ${error.message}`);
  return { sb, uid: data.user.id, email };
}

async function acharAnuncio(sb, uid) {
  const { data, error } = await sb
    .from('suppliers').select('*')
    .eq('created_by', uid).eq('business_name', NOME_ANUNCIO).limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

async function garantirPlano(sb) {
  // O trigger enforce_supplier_ad_rules recusa publicar anúncio sem plano
  // vigente. Só assina se não houver nada -- não troca nem mexe num plano que
  // já exista, para o seed não alterar o cenário que alguém esteja testando.
  const { data } = await sb.rpc('my_current_subscription');
  const vigente = data && data.id != null && new Date(data.expires_at) > new Date()
    && ['active', 'cancelled'].includes(data.status);
  if (vigente) {
    console.log(`  plano vigente: ${data.plan_id} (mantido como está)`);
    return;
  }
  // Básico: o seed cria UM anúncio, e plano pago não se ativa mais pela RPC
  // (PAYMENT_REQUIRED -- fix-paid-plan-activation.sql, Resumo.md §231).
  const { error } = await sb.rpc('subscribe_to_plan', { p_plan_id: 'basico' });
  if (error) throw new Error('não consegui assinar um plano: ' + error.message);
  console.log('  plano: assinou basico (a conta estava sem plano)');
}

async function criar() {
  console.log('SEED -- criando dados de teste\n');

  const forn = await entrar('fornecedor');
  console.log(`fornecedor: ${forn.email}`);
  await garantirPlano(forn.sb);

  let anuncio = await acharAnuncio(forn.sb, forn.uid);
  if (anuncio) {
    console.log(`  anúncio: já existia (${anuncio.id}) -- nada a fazer`);
  } else {
    const { data, error } = await forn.sb.from('suppliers').insert({
      created_by: forn.uid,
      business_name: NOME_ANUNCIO,
      // cnpj é NOT NULL na tabela. Um CNPJ obviamente falso (todos zeros) em
      // vez de um válido gerado: este anúncio é público no site de
      // desenvolvimento, e um número que passe em validador convida alguém a
      // tratá-lo como empresa real.
      cnpj: '00.000.000/0000-00',
      description: 'Anúncio criado pelo seed automatizado. Pode apagar.',
      category: 'logistica',
      location: 'São Paulo, SP',
      phone: '(11) 90000-0000',
      email: forn.email,
      min_order: 100,
      status: 'active',
      plan: 'profissional',
    }).select().single();
    if (error) throw new Error('não consegui criar o anúncio: ' + error.message);
    anuncio = data;
    console.log(`  anúncio: criado (${anuncio.id})`);
  }

  const cli = await entrar('cliente');
  console.log(`\ncliente: ${cli.email}`);

  const { data: jaTem } = await cli.sb
    .from('reviews').select('id')
    .eq('supplier_id', anuncio.id).eq('created_by', cli.uid).limit(1);

  if (jaTem?.length) {
    console.log(`  avaliação: já existia (${jaTem[0].id}) -- nada a fazer`);
  } else {
    const { data, error } = await cli.sb.from('reviews').insert({
      created_by: cli.uid,
      supplier_id: anuncio.id,
      reviewer_name: 'Cliente de Teste',
      rating: 5,
      comment: 'Avaliação criada pelo seed automatizado. Pode apagar.',
    }).select().single();
    if (error) throw new Error('não consegui criar a avaliação: ' + error.message);
    console.log(`  avaliação: criada (${data.id}) -- 5 estrelas`);
  }

  console.log('\npronto. rode `npm run e2e` -- o teste de avaliações recebidas deve sair do skip.');
}

async function apagar() {
  console.log('SEED -- limpando dados de teste\n');

  const forn = await entrar('fornecedor');
  const anuncio = await acharAnuncio(forn.sb, forn.uid);
  if (!anuncio) {
    console.log('nada a limpar: o anúncio do seed não existe.');
    return;
  }

  // As avaliações saem ANTES do anúncio. Se a FK for restrict, apagar o
  // anúncio primeiro falharia; se for cascade, apagar depois seria trabalho
  // perdido mas inofensivo. Nesta ordem funciona nos dois casos.
  const cli = await entrar('cliente');
  const { error: e1, count } = await cli.sb
    .from('reviews').delete({ count: 'exact' })
    .eq('supplier_id', anuncio.id).eq('created_by', cli.uid);
  if (e1) console.log('  aviso ao apagar avaliações: ' + e1.message);
  else console.log(`  avaliações removidas: ${count ?? 0}`);

  // PRODUTOS: pertencem à CONTA, não ao anúncio (product-catalog.sql), então
  // NÃO somem com ele -- o cascade de suppliers só leva os VÍNCULOS
  // (supplier_products) e a galeria (supplier_images). Antes desta limpeza
  // eles ficavam órfãos no Catálogo (seção 158). Os ids são lidos ANTES de
  // apagar o anúncio, porque depois o vínculo que os identifica já sumiu.
  const { data: vinculos, error: e3 } = await forn.sb
    .from('supplier_products').select('product_id').eq('supplier_id', anuncio.id);
  if (e3) throw new Error('não consegui ler os produtos do anúncio: ' + e3.message);
  const produtoIds = [...new Set((vinculos || []).map((v) => v.product_id))];

  const { count: galeria } = await forn.sb
    .from('supplier_images').select('id', { count: 'exact', head: true }).eq('supplier_id', anuncio.id);

  const { error: e2 } = await forn.sb.from('suppliers').delete().eq('id', anuncio.id);
  if (e2) throw new Error('não consegui apagar o anúncio: ' + e2.message);
  console.log(`  anúncio removido: ${anuncio.id}`);
  console.log(`  imagens da galeria removidas (cascade): ${galeria ?? 0}`);

  // Só apaga o produto que ficou SEM nenhum outro anúncio. Um produto que
  // também aparece em outro anúncio da conta não é "do seed", é do
  // catálogo -- e apagá-lo tiraria o produto daquele anúncio também.
  let removidos = 0;
  for (const id of produtoIds) {
    const { count: outros } = await forn.sb
      .from('supplier_products').select('id', { count: 'exact', head: true }).eq('product_id', id);
    if (outros) {
      console.log(`  produto ${id} mantido: está em outro anúncio`);
      continue;
    }
    // product_images sai junto (on delete cascade).
    const { error } = await forn.sb.from('products').delete().eq('id', id);
    if (error) console.log(`  aviso ao apagar o produto ${id}: ${error.message}`);
    else removidos += 1;
  }
  console.log(`  produtos removidos (com as fotos): ${removidos} de ${produtoIds.length}`);

  // O PLANO NÃO É CANCELADO de propósito: o seed pode tê-lo encontrado já
  // existente, e cancelar aqui destruiria um cenário que não é dele.
  console.log('\npronto. o plano da conta não foi tocado.');
}

try {
  await (limpar ? apagar() : criar());
} catch (erro) {
  console.error('\nFALHOU: ' + erro.message);
  process.exit(1);
}
