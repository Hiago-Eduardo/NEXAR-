/**
 * SEED VISUAL -- enche o site de desenvolvimento com dados para teste visual
 * (seção 170): anúncios com galeria, catálogo de produtos, avaliações,
 * pedidos de orçamento e conversas de chat entre as duas contas de teste.
 *
 *   npm run seed:visual          -- cria (idempotente: anúncio que já existe é pulado)
 *   npm run seed:visual:limpar   -- remove TUDO que este script criou
 *
 * ESCREVE NO BANCO DE DESENVOLVIMENTO COMPARTILHADO -- exige --confirmo, como
 * o seed-teste.mjs. Todo anúncio criado aqui começa com [TESTE] e tem o nome
 * na lista ANUNCIOS abaixo: é assim que a limpeza o reconhece. Mensagens,
 * pedidos, avaliações e produtos são achados pelo anúncio a que pertencem.
 *
 * NÃO CRIA NOTIFICAÇÕES DE SISTEMA: só triggers de `subscriptions` gravam em
 * `notifications`, e o seed não mexe em plano. As mensagens de chat recebidas
 * aparecem na central de Notificações e no contador de Mensagens.
 *
 * Imagens são placehold.co (URL externa) -- nada vai para o Storage, então
 * não sobra arquivo depois da limpeza.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

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
  console.error('Recusado: este script ESCREVE no banco. Rode por `npm run seed:visual`.');
  process.exit(1);
}

const img = (w, h, cor, texto) =>
  `https://placehold.co/${w}x${h}/${cor}/FFFFFF/png?text=${encodeURIComponent(texto)}`;

const diasAtras = (d, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString();

// ---------------------------------------------------------------------------
// DADOS
// ---------------------------------------------------------------------------
const ANUNCIOS = [
  {
    business_name: '[TESTE] Sabor do Campo Alimentos',
    category: 'alimentos_bebidas',
    location: 'Campinas, SP',
    description: 'Distribuidora de alimentos para restaurantes, padarias e mercados. Laticínios, frios, grãos e hortifruti com entrega refrigerada três vezes por semana em toda a região de Campinas.',
    tags: ['Entrega refrigerada', 'Nota fiscal em todos os pedidos', 'Pedido pelo WhatsApp'],
    min_order: 'R$ 500,00',
    delivery_info: 'Região de Campinas em 24h · Capital em 48h',
    phone: '(19) 3232-4400', website: 'https://exemplo-sabordocampo.com.br',
    cores: ['15803d', '166534', '1e293b'], imagens: ['Laticinios', 'Hortifruti', 'Estoque'],
    produtos: [
      { name: 'Queijo muçarela (peça 4 kg)', price: 132.9, unit: 'kg', fotos: 2 },
      { name: 'Arroz tipo 1 (fardo 30 kg)', price: 159, unit: 'un', fotos: 1 },
    ],
    avaliacao: { rating: 5, comment: 'Entrega sempre no horário e produto bem refrigerado. Virou nosso fornecedor principal.' },
    pedido: { status: 'pending', message: 'Precisamos de 40 kg de muçarela por semana para duas unidades. Conseguem preço fixo por 3 meses?' },
    conversa: [
      ['cliente', 'Oi! Vocês entregam em Valinhos?', 3, 5],
      ['dono', 'Olá! Entregamos sim, às terças e sextas. Qual o volume aproximado?', 3, 4],
      ['cliente', 'Uns 40 kg de muçarela e 60 kg de arroz por semana.', 3, 3],
      ['dono', 'Perfeito. Mando a tabela com desconto por volume ainda hoje.', 0, 2],
    ],
    leituraCliente: false, // resposta do dono fica NÃO LIDA para o cliente
  },
  {
    business_name: '[TESTE] Embala Mais Embalagens',
    category: 'embalagens',
    location: 'Curitiba, PR',
    description: 'Caixas de papelão, sacos kraft, fitas e embalagens personalizadas para e-commerce. Impressão com a sua marca a partir de 500 unidades.',
    tags: ['Personalização com logo', 'Pronta entrega', 'Frete grátis acima de R$ 1.000'],
    min_order: 'R$ 300,00',
    delivery_info: 'Sul e Sudeste em até 5 dias úteis',
    phone: '(41) 3014-7788', website: 'https://exemplo-embalamais.com.br',
    cores: ['b45309', '92400e', '1e293b'], imagens: ['Caixas', 'Kraft', 'Grafica'],
    produtos: [
      { name: 'Caixa de papelão 30x20x15 (pct 25)', price: 89.5, unit: 'pct', fotos: 3 },
      { name: 'Saco kraft com alça (cx 100)', price: 64, unit: 'cx', fotos: 1 },
      { name: 'Fita adesiva personalizada', price: 12.9, unit: 'un', fotos: 1 },
    ],
    avaliacao: { rating: 4, comment: 'Qualidade boa, mas o prazo da personalização atrasou dois dias.' },
    pedido: { status: 'replied', message: 'Orçamento para 2.000 caixas 30x20x15 com impressão 1 cor.' },
    conversa: [
      ['cliente', 'Qual o prazo para caixas personalizadas?', 6, 2],
      ['dono', 'De 7 a 10 dias úteis depois da aprovação da arte.', 6, 1],
      ['cliente', 'Ótimo, vou mandar a arte por aqui.', 5, 20],
    ],
    leituraDono: false, // última mensagem do cliente fica NÃO LIDA para o dono
  },
  {
    business_name: '[TESTE] TechNova Soluções em TI',
    category: 'tecnologia',
    location: 'Belo Horizonte, MG',
    description: 'Notebooks, periféricos e montagem de redes para escritórios. Locação de equipamentos com suporte técnico incluso.',
    tags: ['Locação com suporte', 'Garantia estendida', 'Atendimento em todo o Brasil'],
    min_order: 'Sem pedido mínimo',
    delivery_info: 'Capitais em até 3 dias úteis',
    phone: '(31) 3555-1020', website: 'https://exemplo-technova.com.br',
    cores: ['1d4ed8', '1e3a8a', '0f172a'], imagens: ['Notebooks', 'Rede', 'Suporte'],
    produtos: [
      { name: 'Notebook i5 16 GB (locação mensal)', price: 219, unit: 'un', fotos: 2 },
    ],
    avaliacao: { rating: 3, comment: 'Equipamento bom, suporte demorou a responder na primeira semana.' },
    pedido: { status: 'closed', message: 'Locação de 12 notebooks por 6 meses para equipe comercial.' },
    conversa: [
      ['cliente', 'Vocês fazem locação por 6 meses?', 12, 0],
      ['dono', 'Fazemos sim, a partir de 5 equipamentos.', 11, 22],
    ],
  },
  {
    business_name: '[TESTE] Bela Pele Cosméticos',
    category: 'cosmeticos_beleza',
    location: 'Recife, PE',
    description: 'Fabricante de cosméticos veganos: sabonetes, hidratantes e óleos corporais. Linha própria e terceirização (private label).',
    tags: ['Vegano e cruelty-free', 'Private label', 'Registro na Anvisa'],
    min_order: 'R$ 800,00',
    delivery_info: 'Nordeste em 3 dias · Demais regiões em até 8 dias',
    phone: '(81) 3040-2211', website: '',
    cores: ['be185d', '9d174d', '1e293b'], imagens: ['Sabonetes', 'Hidratantes'],
    produtos: [
      { name: 'Sabonete artesanal vegano (cx 50)', price: 245, unit: 'cx', fotos: 2 },
      { name: 'Óleo corporal 120 mL', price: 18.5, unit: 'un', fotos: 1 },
    ],
    avaliacao: { rating: 5, comment: 'Produtos excelentes e a equipe ajudou muito com o rótulo do private label.' },
  },
  {
    business_name: '[TESTE] Papel & Cia Papelaria',
    category: 'papelaria',
    location: 'Porto Alegre, RS',
    description: 'Material de escritório e escolar no atacado. Papel A4, cadernos, canetas e suprimentos de impressão.',
    tags: ['Atacado', 'Entrega em 24h na capital'],
    min_order: 'R$ 200,00',
    delivery_info: 'Porto Alegre em 24h',
    phone: '(51) 3222-9090', website: 'https://exemplo-papelecia.com.br',
    cores: ['7c3aed', '5b21b6'], imagens: ['Papelaria', 'Escritorio'],
    produtos: [
      { name: 'Papel A4 75 g (cx 10 resmas)', price: 289, unit: 'cx', fotos: 1 },
    ],
  },
  {
    business_name: '[TESTE] Fio Nobre Confecções',
    category: 'moda_vestuario',
    location: 'Blumenau, SC',
    description: 'Confecção de uniformes corporativos e camisetas promocionais. Bordado e silk no próprio parque fabril.',
    tags: ['Bordado e silk próprios', 'Grade do PP ao G4', 'Amostra antes do pedido'],
    min_order: '50 peças',
    delivery_info: 'Todo o Brasil em até 15 dias',
    phone: '(47) 3326-5500', website: 'https://exemplo-fionobre.com.br',
    cores: ['0f766e', '115e59', '1e293b'], imagens: ['Uniformes', 'Bordado', 'Fabrica'],
    produtos: [
      { name: 'Camiseta algodão com logo bordado', price: 38.9, unit: 'un', fotos: 3 },
      { name: 'Polo piquet uniforme', price: 54, unit: 'un', fotos: 2 },
    ],
    avaliacao: { rating: 4, comment: 'Acabamento muito bom. O bordado ficou perfeito.' },
    pedido: { status: 'pending', message: 'Cotação de 300 polos com bordado no peito, tamanhos variados.' },
  },
];

// ---------------------------------------------------------------------------
async function entrar(papel) {
  const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY);
  const email = papel === 'fornecedor' ? env.TEST_FORNECEDOR_EMAIL : env.TEST_CLIENTE_EMAIL;
  const senha = papel === 'fornecedor' ? env.TEST_FORNECEDOR_PASSWORD : env.TEST_CLIENTE_PASSWORD;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(`login de ${papel} (${email}) falhou: ${error.message}`);
  return { sb, uid: data.user.id, email: data.user.email };
}

const falhou = (o, msg) => { if (o.error) throw new Error(`${msg}: ${o.error.message}`); return o.data; };

async function anunciosDoSeed(forn) {
  const { data, error } = await forn.sb.from('suppliers').select('id, business_name')
    .eq('created_by', forn.uid).in('business_name', ANUNCIOS.map((a) => a.business_name));
  if (error) throw error;
  return data || [];
}

async function criar() {
  const forn = await entrar('fornecedor');
  const cli = await entrar('cliente');
  console.log(`fornecedor: ${forn.email}\ncliente:    ${cli.email}\n`);

  const existentes = new Map((await anunciosDoSeed(forn)).map((a) => [a.business_name, a.id]));

  for (const [i, a] of ANUNCIOS.entries()) {
    if (existentes.has(a.business_name)) {
      console.log(`- ${a.business_name}: já existe, pulado`);
      continue;
    }
    console.log(`+ ${a.business_name}`);

    // 1) anúncio
    const ad = falhou(await forn.sb.from('suppliers').insert({
      created_by: forn.uid,
      business_name: a.business_name,
      cnpj: '00.000.000/0000-00',
      description: a.description,
      category: a.category,
      location: a.location,
      phone: a.phone,
      email: `contato+${i}@exemplo-nexar-teste.com.br`,
      website: a.website || null,
      min_order: a.min_order,
      delivery_info: a.delivery_info,
      logo_url: img(200, 200, a.cores[0], a.business_name.replace('[TESTE] ', '').slice(0, 2).toUpperCase()),
      tags: a.tags,
      status: 'active',
      plan: 'premium',
      created_at: diasAtras(20 - i * 3),
    }).select('id').single(), 'anúncio');

    // 2) galeria (a primeira vira a capa, trigger trg_sync_supplier_cover)
    falhou(await forn.sb.from('supplier_images').insert(
      a.imagens.map((t, pos) => ({ supplier_id: ad.id, url: img(1200, 900, a.cores[pos % a.cores.length], t), position: pos }))
    ), 'galeria');

    // 3) produtos no catálogo + vínculo com o anúncio
    for (const p of a.produtos || []) {
      const prod = falhou(await forn.sb.from('products').insert({
        created_by: forn.uid,
        name: p.name,
        description: `${p.name}. Produto de demonstração do site de testes.`,
        price: p.price,
        unit: p.unit,
        min_quantity: 1,
        in_stock: true,
        category: a.category,
      }).select('id').single(), 'produto');
      falhou(await forn.sb.from('product_images').insert(
        Array.from({ length: p.fotos }, (_, pos) => ({
          product_id: prod.id, url: img(800, 800, a.cores[pos % a.cores.length], `${p.name.split(' ')[0]} ${pos + 1}`), position: pos,
        }))
      ), 'fotos do produto');
      falhou(await forn.sb.from('supplier_products').insert({ supplier_id: ad.id, product_id: prod.id }), 'vínculo produto');
    }

    // 4) avaliação do cliente
    if (a.avaliacao) {
      falhou(await cli.sb.from('reviews').insert({
        created_by: cli.uid, supplier_id: ad.id, reviewer_name: 'Mercado Bom Preço', ...a.avaliacao,
      }), 'avaliação');
    }

    // 5) pedido de orçamento do cliente; o dono muda o status pela RPC
    if (a.pedido) {
      const pedido = falhou(await cli.sb.from('contact_requests').insert({
        created_by: cli.uid, supplier_id: ad.id,
        sender_name: 'Mercado Bom Preço', sender_email: cli.email, sender_phone: '(11) 98888-7777',
        message: a.pedido.message,
      }).select('id').single(), 'pedido');
      if (a.pedido.status !== 'pending') {
        falhou(await forn.sb.rpc('set_contact_request_status', { p_id: pedido.id, p_status: a.pedido.status }), 'status do pedido');
      }
    }

    // 6) conversa -- o trigger route_chat_message decide remetente/destino.
    if (a.conversa) {
      const conversationId = [cli.email, ad.id].sort().join('__');
      for (const [quem, texto, dias, horas] of a.conversa) {
        const conta = quem === 'cliente' ? cli : forn;
        falhou(await conta.sb.from('chat_messages').insert({
          conversation_id: conversationId,
          sender_id: conta.email,
          sender_name: quem === 'cliente' ? 'Mercado Bom Preço' : a.business_name,
          receiver_id: quem === 'cliente' ? ad.id : cli.email,
          receiver_name: quem === 'cliente' ? a.business_name : 'Mercado Bom Preço',
          message: texto,
          image_url: '',
          ad_id: ad.id,
          created_at: diasAtras(dias, -horas),
        }), 'mensagem');
      }
      // Tudo lido, menos o que o cenário quer deixar como "não lida".
      if (a.leituraCliente !== false) await cli.sb.rpc('mark_conversation_read', { p_conversation_id: conversationId });
      if (a.leituraDono !== false) await forn.sb.rpc('mark_conversation_read', { p_conversation_id: conversationId });
    }
  }
  console.log('\npronto. `npm run seed:visual:limpar` desfaz tudo.');
}

async function apagar() {
  const forn = await entrar('fornecedor');
  const cli = await entrar('cliente');
  const ads = await anunciosDoSeed(forn);
  if (!ads.length) { console.log('nada a limpar.'); return; }
  const ids = ads.map((a) => a.id);

  // Cada conta apaga o que ela mesma escreveu (policies de delete).
  for (const conta of [cli, forn]) {
    const r = await conta.sb.from('chat_messages').delete({ count: 'exact' }).in('ad_id', ids);
    console.log(`  mensagens de ${conta.email}: ${r.error ? 'ERRO ' + r.error.message : r.count}`);
  }
  const rp = await cli.sb.from('contact_requests').delete({ count: 'exact' }).in('supplier_id', ids);
  console.log(`  pedidos: ${rp.error ? 'ERRO ' + rp.error.message : rp.count}`);
  const rr = await cli.sb.from('reviews').delete({ count: 'exact' }).in('supplier_id', ids);
  console.log(`  avaliações: ${rr.error ? 'ERRO ' + rr.error.message : rr.count}`);

  const vinc = falhou(await forn.sb.from('supplier_products').select('product_id').in('supplier_id', ids), 'vínculos');
  const produtoIds = [...new Set(vinc.map((v) => v.product_id))];

  const ra = await forn.sb.from('suppliers').delete({ count: 'exact' }).in('id', ids);
  if (ra.error) throw new Error('apagar anúncios: ' + ra.error.message);
  console.log(`  anúncios (galeria e vínculos em cascata): ${ra.count}`);

  let removidos = 0;
  for (const id of produtoIds) {
    const { count } = await forn.sb.from('supplier_products').select('id', { count: 'exact', head: true }).eq('product_id', id);
    if (count) continue; // está em outro anúncio: não é só do seed
    const r = await forn.sb.from('products').delete().eq('id', id);
    if (!r.error) removidos += 1;
  }
  console.log(`  produtos: ${removidos} de ${produtoIds.length}`);
}

try {
  await (limpar ? apagar() : criar());
} catch (erro) {
  console.error('\nFALHOU: ' + erro.message);
  process.exit(1);
}
