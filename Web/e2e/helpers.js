import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lê o .env.local na mão.
 *
 * O Playwright não passa pelo Vite, então `import.meta.env` não existe aqui --
 * e o .env.local é o lugar certo para as credenciais de teste porque o
 * .gitignore já o cobre (regra `*.local`, confirmado na seção 79).
 */
function loadEnvLocal() {
  const file = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...loadEnvLocal(), ...process.env };

export const CREDENCIAIS = {
  fornecedor: {
    email: env.TEST_FORNECEDOR_EMAIL,
    senha: env.TEST_FORNECEDOR_PASSWORD,
  },
  cliente: {
    email: env.TEST_CLIENTE_EMAIL,
    senha: env.TEST_CLIENTE_PASSWORD,
  },
};

export function temCredencial(papel) {
  return !!(CREDENCIAIS[papel]?.email && CREDENCIAIS[papel]?.senha);
}

/**
 * `test` estendido que FALHA se a página escrever erro no console.
 *
 * Esta é a parte mais valiosa do arquivo. O bug da seção 104
 * ("nextQuery.order is not a function") era um TypeError jogado no console
 * enquanto a tela apenas mostrava uma lista vazia -- indistinguível de "não há
 * dados". Qualquer teste que apenas abrisse a página passaria. Com este
 * fixture, ele quebra na hora, em qualquer tela.
 *
 * Ruído conhecido entra em IGNORAR, sempre com o motivo escrito.
 */
const IGNORAR = [
  // O Vite injeta avisos de HMR/websocket em dev que não são do app.
  /\[vite\]/i,
  // Imagem de teste que não existe no storage não é defeito de código.
  /Failed to load resource.*\.(png|jpg|jpeg|webp|svg)/i,
];

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const erros = [];

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const texto = msg.text();
      if (IGNORAR.some((re) => re.test(texto))) return;
      erros.push(texto);
    });

    page.on('pageerror', (err) => {
      erros.push(`pageerror: ${err.message}`);
    });

    await use(page);

    if (erros.length && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `A página registrou ${erros.length} erro(s) no console:\n  - ${erros.join('\n  - ')}`
      );
    }
  },
});

export { expect };

/**
 * Login pela tela de verdade (não injetando token): é o fluxo que o usuário
 * percorre, então também serve de teste do Login.jsx.
 */
export async function entrar(page, papel) {
  const { email, senha } = CREDENCIAIS[papel];
  await page.goto('/Login');
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(senha); // exato: o botão "Mostrar senha" também casa com /senha/i
  // Âncoras (^$) de propósito: /entrar/ sozinho casava TAMBÉM com o botão
  // "Entrar / Cadastrar" da navbar, que existe em toda página -- dois
  // elementos, e o Playwright falha por strict mode antes mesmo de tentar
  // logar. O bug estava aqui desde que este helper nasceu e nunca apareceu
  // porque os testes com conta ficavam pulados por falta de credencial
  // (seção 121).
  await page.getByRole('button', { name: /^(entrar|acessar|login)$/i }).click();

  // Credencial recusada aparece na tela em menos de um segundo. Sem este
  // atalho, a falha vira um timeout de 15s no `not.toHaveURL` abaixo, que diz
  // "continuou em /Login" -- verdadeiro e inútil. Aqui a mensagem nomeia a
  // causa, que é a diferença entre "o teste quebrou" e "a senha está errada".
  const recusado = page.getByText(/credenciais inválidas|invalid login|e-?mail ou senha/i);
  const erro = await recusado.first().waitFor({ timeout: 2000 }).then(() => true, () => false);
  if (erro) {
    throw new Error(
      `Login recusado para o papel "${papel}" (${email}). ` +
      `Confira TEST_${papel.toUpperCase()}_EMAIL/PASSWORD no .env.local.`
    );
  }

  // O app redireciona para fora do /Login quando a sessão sobe.
  await expect(page).not.toHaveURL(/\/Login/, { timeout: 15000 });
}

/**
 * REGRA DESTA SUÍTE: os testes LEEM, não escrevem.
 *
 * Eles rodam contra o banco de desenvolvimento real, que tem dados de verdade.
 * Um teste que grava deixa lixo permanente -- uma avaliação 5 estrelas órfã
 * infla a reputação de um fornecedor, um anúncio de teste aparece na vitrine
 * pública. E, diferente de um banco de teste descartável, aqui não há
 * `truncate` no fim.
 *
 * O único write aceito por padrão é o LOGIN (cria sessão, não cria linha).
 *
 * Teste que precisa gravar fica atrás de `E2E_ALLOW_WRITES=1` e tem que
 * limpar o que criou. Ver o teste de auto-avaliação em avaliacoes.spec.js.
 */
export const PODE_ESCREVER = process.env.E2E_ALLOW_WRITES === '1';
