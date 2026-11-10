import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright -- testes de ponta a ponta no navegador de verdade.
 *
 * POR QUE ISTO EXISTE: até a seção 105, NENHUMA tela do projeto tinha sido
 * aberta num navegador por mim -- toda validação era build, lint, varredura de
 * classes e chamada de RPC. Bugs que só existem em runtime (a lista de
 * avaliações vazia da seção 104, o cache limpo da 103) precisaram de várias
 * idas e vindas com o usuário colando o que via. Estes testes fecham isso.
 *
 * Rodar:
 *   npm run e2e           -- headless, o padrão
 *   npm run e2e:headed    -- abre o navegador para você ver
 *   npm run e2e:ui        -- modo interativo do Playwright
 *
 * PRÉ-REQUISITO, UMA VEZ SÓ: `npx playwright install chromium`.
 * Os testes que dependem de login são pulados sozinhos se TEST_USER_* não
 * estiver no .env.local -- ver e2e/helpers.js.
 */
export default defineConfig({
  testDir: './e2e',
  // Um worker: os testes conversam com o MESMO banco de desenvolvimento, e
  // paralelizar escrita num banco compartilhado gera falha intermitente que
  // custa mais tempo do que a lentidão economizada.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    // Rastro só do que falhou -- screenshot e vídeo de tudo enchem o disco.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // `channel: 'chrome'` usa o Google Chrome JÁ INSTALADO na máquina, em vez do
  // Chromium que o Playwright baixaria (~300MB). Além de dispensar o
  // download, é o navegador real dos usuários. Trocar para 'msedge' se um dia
  // o Chrome sair da máquina; sem channel nenhum, volta a exigir
  // `npx playwright install chromium`.
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
  // Reaproveita o `npm run dev` que já estiver de pé; sobe um se não houver.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60000,
  },
});
