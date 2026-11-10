import { test, expect, temCredencial, entrar } from './helpers.js';

/**
 * Tela Planos -- as correções das seções 109 e 111.
 *
 * O grupo mais importante daqui é o primeiro: ele trava as promessas que a
 * tela NÃO pode voltar a fazer. A auditoria da seção 109 encontrou cinco
 * afirmações vendidas ao fornecedor que o produto não entrega, e texto de
 * vitrine é justamente o tipo de coisa que volta sem querer -- alguém copia de
 * um concorrente, ou reaproveita um material antigo de marketing. Um teste que
 * falha na hora é mais barato do que descobrir pelo cliente que reclamou.
 */
test.describe('Planos -- promessas que o produto não cumpre', () => {
  // Cada string aqui saiu da tela por um motivo verificado no código, não por
  // gosto. Ver o comentário do array `plans` em Planos.jsx.
  const PROIBIDAS = [
    // A busca ordena por created_at desc -- não conhece plano.
    'Melhor posicionamento nas buscas',
    'Destaque nas buscas',
    // Não existe suporte no produto: só um "Em breve" em Configurações.
    'Suporte prioritário',
    'Prioridade máxima no suporte',
    // Não são benefício de plano -- todo plano tem.
    'Pausar e reativar anúncios quando quiser',
    'Produtos e serviços no perfil',
  ];

  for (const frase of PROIBIDAS) {
    test(`não promete "${frase}"`, async ({ page }) => {
      await page.goto('/Planos');
      await expect(page.getByText(frase, { exact: false })).toHaveCount(0);
    });
  }

  test('mostra os limites que o banco realmente impõe', async ({ page }) => {
    await page.goto('/Planos');
    // Limites de catálogo e de fotos: são enforced por trigger
    // (enforce_product_catalog_rules / enforce_product_image_rules) e não
    // apareciam em lugar nenhum antes da seção 109.
    await expect(page.getByText('Até 5 produtos no catálogo')).toBeVisible();
    await expect(page.getByText('Até 30 produtos no catálogo')).toBeVisible();
    await expect(page.getByText('Produtos no catálogo ilimitados')).toBeVisible();
    await expect(page.getByText('1 foto por produto')).toBeVisible();
    await expect(page.getByText('3 fotos por produto')).toBeVisible();
    await expect(page.getByText('8 fotos por produto')).toBeVisible();
  });
});

test.describe('Planos -- visitante sem conta', () => {
  test('mostra os três planos e leva ao cadastro', async ({ page }) => {
    await page.goto('/Planos');

    await expect(page.getByRole('heading', { name: 'Básico' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Profissional' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Premium' })).toBeVisible();

    // Sem conta NUNCA existe um caminho que contrate direto -- era assim que o
    // ?set_plan= concedia plano sem passar por lugar nenhum (seção 81).
    // Plano pago sem contratação online (C1, Resumo.md §231): o cartão diz
    // que está em preparação e o botão só leva ao cadastro.
    await expect(page.getByText('Contratação online em preparação').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Assinar agora' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Criar conta', exact: true }).first().click();
    await expect(page).toHaveURL(/\/Register/);
  });

  test('os três cartões têm a mesma quantidade de linhas (seção 109)', async ({ page }) => {
    await page.goto('/Planos');
    // As listas paralelas são o que alinha os cartões e permite comparar na
    // horizontal. Se alguém adicionar um item a um plano só, o alinhamento
    // quebra e este teste avisa.
    const listas = page.locator('ul').filter({ has: page.locator('li') });
    const contagens = [];
    for (let i = 0; i < 3; i += 1) {
      contagens.push(await listas.nth(i).locator('li').count());
    }
    expect(new Set(contagens).size).toBe(1);
  });
});

test.describe('Planos -- com conta', () => {
  test.skip(!temCredencial('fornecedor'), 'defina TEST_FORNECEDOR_* no .env.local');

  test('o plano atual aparece marcado e não é clicável', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto(`/Planos?manage=1`);

    // `count()` NÃO ESPERA -- responde na hora. A assinatura é carregada por
    // api.subscriptions.getCurrent() depois da montagem, então contar logo
    // após o goto dava sempre zero e o teste PULAVA mesmo com plano vigente
    // (seção 129). O waitFor dá à carga assíncrona a chance de acontecer
    // antes de decidir; o catch mantém o pulo possível para uma conta que
    // realmente não tenha plano.
    const atual = page.getByRole('button', { name: 'Seu plano atual' });
    await atual.first().waitFor({ timeout: 8000 }).catch(() => {});
    if ((await atual.count()) === 0) test.skip(true, 'esta conta não tem plano vigente');
    await expect(atual).toBeDisabled();
  });

  test('plano pago que não é o atual não pode ser contratado (C1)', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto(`/Planos?manage=1`);
    // Só lê: nenhum clique que contrate. Premium é o topo; se a conta já é
    // Premium, o Profissional (downgrade pago) também fica indisponível.
    const indisponivel = page.getByRole('button', { name: 'Pagamento em preparação' });
    await indisponivel.first().waitFor({ timeout: 8000 });
    for (const b of await indisponivel.all()) await expect(b).toBeDisabled();
  });

  test('trocar de plano pago abre o alerta e explica quando cobra', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto(`/Planos?manage=1`);

    // Mesma corrida do teste acima: sem o waitFor, o count roda antes de a
    // assinatura chegar e o teste pula sempre.
    const trocar = page.getByRole('button', { name: 'Trocar de plano' }).first();
    await trocar.waitFor({ timeout: 8000 }).catch(() => {});
    if ((await trocar.count()) === 0) {
      test.skip(true, 'esta conta não está num plano pago -- a troca seria imediata');
    }

    await trocar.click();

    // As frases que o alerta existe para dizer. Só ABRE o diálogo e lê -- não
    // confirma, porque confirmar escreve no banco e a regra da suíte é ler,
    // não escrever (helpers.js).
    //
    // O botão "Trocar de plano" só aparece em DOWNGRADE desde a seção 121
    // (upgrade agora vale na hora e usa o rótulo do próprio plano), então o
    // texto esperado é o do agendamento para o dia 10.
    await expect(page.getByText(/dia 10/i).first()).toBeVisible();
    await expect(page.getByText(/Nada é cobrado agora/i)).toBeVisible();
    await expect(page.getByText(/nenhum dia já pago é perdido/i)).toBeVisible();

    await page.getByRole('button', { name: 'Voltar' }).click();
  });
});
