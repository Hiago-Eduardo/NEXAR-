/**
 * Landmarks de acessibilidade em todas as páginas públicas.
 *
 * Nasceu de um achado real: o primeiro screenshot que tirei da listagem
 * mostrou DOIS <main> na página -- o Layout.jsx envolve toda página num, e
 * Suppliers.jsx e Planos.jsx abriam outro dentro dele. Leitor de tela anuncia
 * dois "conteúdos principais". Ver seção 107.
 */
import { test, expect } from '@playwright/test';

// Landmark main: exatamente um por documento, em toda pagina publica.
for (const rota of ['/', '/Suppliers', '/Planos', '/Sobre', '/Login', '/Register']) {
  test(`um unico <main> em ${rota}`, async ({ page }) => {
    // O widget do Turnstile (Login, §228) mantém conexões abertas e a página
    // nunca chega a 'networkidle'. Ele não mexe em landmarks: fica de fora.
    await page.route('**/challenges.cloudflare.com/**', (r) => r.abort());
    await page.goto(rota);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main')).toHaveCount(1);
  });
}
