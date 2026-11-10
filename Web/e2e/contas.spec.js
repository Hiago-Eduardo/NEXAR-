import { test, expect, entrar, temCredencial } from './helpers';

// Auditoria de Chat, Notificações, Configurações e Pagamento (seção 169).
// Só LEITURA: nenhum teste envia mensagem, troca senha ou marca como lido.

test.describe('Telas de conta -- visitante sem conta', () => {
  test('Chat pede login e guarda a conversa no from', async ({ page }) => {
    await page.goto('/Chat?supplier_id=abc&ad_id=abc');
    await expect(page).toHaveURL(/\/Login\?from=%2FChat%3Fsupplier_id%3Dabc/);
  });

  test('Notificações pede login', async ({ page }) => {
    await page.goto('/Notificacoes');
    await expect(page).toHaveURL(/\/Login\?from=%2FNotificacoes/);
  });
});

test.describe('Telas de conta -- fornecedor', () => {
  test.skip(!temCredencial('fornecedor'), 'defina TEST_FORNECEDOR_* no .env.local');

  test('Pagamento não pede cartão nem mostra cartão salvo falso', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Pagamento');
    await expect(page.getByText('O pagamento pelo site ainda não está disponível.')).toBeVisible();
    await expect(page.getByText(/4242/)).toHaveCount(0);
    await expect(page.getByPlaceholder('0000 0000 0000 0000')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /trocar de plano|escolher um plano/i })).toBeVisible();
  });

  test('Configurações: senha atual exigida e sem chaves de notificação falsas', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Configuracoes');
    // Fechado por padrão desde a seção 176: abre pelo botão.
    await page.getByRole('button', { name: 'Alterar senha' }).click();
    await expect(page.locator('#current-password')).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
    await expect(page.getByText('Perfil público da empresa')).toBeVisible();
  });

  test('no próprio anúncio não há chat nem orçamento para si mesmo', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Dashboard');
    const link = page.locator('a[href*="SupplierProfile?id="]').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByText('Este é o seu anúncio')).toBeVisible();
    await expect(page.getByRole('button', { name: /abrir chat/i })).toHaveCount(0);
  });

  test('Notificações não lista as mensagens que a própria pessoa enviou', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Notificacoes');
    await expect(page.getByText('Central de notificações')).toBeVisible();
    await expect(page.getByText('Mensagem enviada')).toHaveCount(0);
  });
});

test.describe('Telas de conta -- cliente', () => {
  test.skip(!temCredencial('cliente'), 'defina TEST_CLIENTE_* no .env.local');

  test('Pagamento manda o cliente para Fornecedores', async ({ page }) => {
    await entrar(page, 'cliente');
    await page.goto('/Pagamento');
    await expect(page).toHaveURL(/\/Suppliers/);
  });

  test('Configurações do cliente não fala de perfil público de empresa', async ({ page }) => {
    await entrar(page, 'cliente');
    await page.goto('/Configuracoes');
    // Fechado por padrão desde a seção 176: abre pelo botão.
    await page.getByRole('button', { name: 'Alterar senha' }).click();
    await expect(page.locator('#current-password')).toBeVisible();
    await expect(page.getByText('Perfil público da empresa')).toHaveCount(0);
  });

  test('Chat no celular mostra a lista, sem a conversa empilhada embaixo', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await entrar(page, 'cliente');
    await page.goto('/Chat');
    await expect(page.getByText('Conversas', { exact: true })).toBeVisible();
    await expect(page.getByText('Selecione uma conversa')).toBeHidden();
  });
});
