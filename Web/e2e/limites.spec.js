import { test, expect, entrar, temCredencial } from './helpers.js';

/**
 * Limites de plano -- telas do fornecedor depois da função central
 * (plan-limits-central.sql, Resumo.md seções 184-185).
 *
 * Só LEITURA: nenhum teste pausa, ativa ou cria nada. O comportamento do
 * banco (suspender, restaurar, corrida) é coberto por
 * src/api/subscription-flow.banco.test.js e pelos testes dentro da migration.
 */
test.describe('Limites de plano -- fornecedor', () => {
  test.skip(!temCredencial('fornecedor'), 'defina TEST_FORNECEDOR_* no .env.local');

  test('Catálogo separa produtos ATIVOS de CADASTRADOS e oferece pausar', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Catalogo');

    // Um dos três resumos: limitado (ativos x cadastrados), ilimitado, ou sem plano.
    // Timeout maior: na primeira visita o Vite ainda compila a página, e a
    // assinatura chega depois -- 5 s falhou uma vez assim.
    await expect(
      page.getByText(/produtos ativos no plano .* cadastrados|no catálogo · ilimitado|precisa de um plano ativo/)
    ).toBeVisible({ timeout: 15_000 });

    // Todo produto ativo tem o botão de pausar; nenhum suspenso tem botão
    // de ativar (só o sistema tira da suspensão).
    const editar = page.getByRole('button', { name: 'Editar' });
    await editar.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    const produtos = await editar.count();
    if (produtos > 0) {
      const pausar = await page.getByRole('button', { name: /^Pausar produto / }).count();
      const ativar = await page.getByRole('button', { name: /^Ativar produto / }).count();
      const suspensos = await page.getByText(/^Suspenso/).count();
      expect(pausar + ativar + suspensos).toBe(produtos);
    }
  });

  test('Dashboard nomeia o estado de cada anúncio com o rótulo novo', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Dashboard');
    await expect(page.getByText('Meus Anúncios')).toBeVisible();
    await page.getByRole('link', { name: /Editar anúncio/ }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    // O rótulo antigo "Suspenso" sozinho não diz o motivo nem o que fazer.
    await expect(page.getByText('Suspenso', { exact: true })).toHaveCount(0);
  });
});
