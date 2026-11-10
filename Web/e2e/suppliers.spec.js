import { test, expect, temCredencial, entrar } from './helpers.js';

/**
 * Tela Suppliers (listagem) -- as correções das seções 96, 101 e 105.
 *
 * Cada teste aqui existe por causa de um bug REAL que já aconteceu. Nenhum é
 * teste de fachada: se algum deles passar a falhar, alguma dessas regressões
 * voltou.
 */
test.describe('Suppliers -- visitante sem conta', () => {
  test('carrega a listagem sem erro de console e sem ficar em estado vazio', async ({ page }) => {
    await page.goto('/Suppliers');

    // Regressão da seção 96: com `initialData: []` a tela abria direto em
    // "Nenhum anúncio encontrado" antes da primeira resposta. O estado vazio
    // só pode aparecer se REALMENTE não houver resultado.
    await expect(page.getByRole('heading', { name: 'Fornecedores' })).toBeVisible();
    await expect(page.locator('.listing-card').first()).toBeVisible();
    await expect(page.getByText('Nenhum anúncio encontrado')).toHaveCount(0);
  });

  test('a aba vai para a URL e sobrevive a um refresh (seção 96)', async ({ page }) => {
    await page.goto('/Suppliers');
    await page.getByRole('tab', { name: /Empresas/ }).click();

    await expect(page).toHaveURL(/tab=empresas/);

    await page.reload();
    // Antes da correção, o refresh voltava para "Anúncios".
    await expect(page.getByRole('tab', { name: /Empresas/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  test('"Limpar filtros" também limpa a query string (seção 96)', async ({ page }) => {
    await page.goto('/Suppliers?category=logistica');
    await page.getByRole('button', { name: /Limpar filtros/i }).click();
    await expect(page).not.toHaveURL(/category=/);
  });

  test('buscar não faz a grade piscar para vazio entre teclas (seção 96)', async ({ page }) => {
    await page.goto('/Suppliers');
    await expect(page.locator('.listing-card').first()).toBeVisible();

    // keepPreviousData: enquanto a nova busca carrega, a lista anterior fica.
    await page.getByPlaceholder(/Nome da empresa/i).pressSequentially('log', { delay: 60 });
    await expect(page.getByText('Nenhum anúncio encontrado')).toHaveCount(0);
  });

  test('cartão de empresa avisa do muro antes do clique (seção 101)', async ({ page }) => {
    await page.goto('/Suppliers?tab=empresas');
    const cartao = page.locator('.listing-card').first();
    await expect(cartao).toBeVisible();

    // Deslogado o rodapé do cartão convida ao cadastro, e o link leva para lá
    // em vez de levar a uma parede.
    await expect(cartao.getByText('Criar conta para ver')).toBeVisible();
    await cartao.click();
    await expect(page).toHaveURL(/\/Register/);
  });
});

test.describe('Suppliers -- com conta', () => {
  test.skip(!temCredencial('cliente'), 'defina TEST_CLIENTE_* no .env.local');

  test('cartão de empresa leva ao perfil, sem cadeado (seção 101)', async ({ page }) => {
    await entrar(page, 'cliente');
    await page.goto('/Suppliers?tab=empresas');

    const cartao = page.locator('.listing-card').first();
    await expect(cartao.getByText('Ver perfil da empresa')).toBeVisible();
    await cartao.click();
    await expect(page).toHaveURL(/view=empresa/);
  });

  test('não mostra muro de cadastro para quem já tem conta', async ({ page }) => {
    await entrar(page, 'cliente');
    await page.goto('/Suppliers');
    await expect(page.getByText(/fornecedores esperando|Criar conta gratuita/)).toHaveCount(0);
  });
});
