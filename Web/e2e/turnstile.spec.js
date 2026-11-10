// Cloudflare Turnstile no localhost (Resumo.md §228).
//
// Usa a chave de TESTE da Cloudflare (1x00000000000000000000AA, sempre
// passa) de .env.development.local -- sem ela, o arquivo inteiro é pulado.
// Enquanto o CAPTCHA não estiver ligado no Supabase o token vai mas o
// servidor não confere; a recusa do Supabase é simulada (page.route).
// Cadastro, recuperação e reenvio são interceptados: nenhuma conta é criada
// e nenhum e-mail sai. O login vai de verdade.
import fs from 'node:fs';
import path from 'node:path';
import { test as testSemVigia } from '@playwright/test';
import { test, expect, entrar, CREDENCIAIS } from './helpers.js';

// Os testes de caminho NEGATIVO simulam de propósito respostas 400/404 e rede
// bloqueada, que o navegador registra no console ("Failed to load
// resource"). Eles usam o `test` puro, sem o vigia de console do
// helpers.js; os de caminho feliz mantêm o vigia.

function siteKeyDev() {
  for (const f of ['.env.development.local', '.env.local']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^VITE_TURNSTILE_SITE_KEY=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  }
  return process.env.VITE_TURNSTILE_SITE_KEY || '';
}
test.skip(siteKeyDev() !== '1x00000000000000000000AA', 'precisa da chave de teste 1x00000000000000000000AA em .env.development.local');

const DUMMY = 'XXXX.DUMMY.TOKEN.XXXX';
const tokenDe = (req) => JSON.parse(req.postData() || '{}')?.gotrue_meta_security?.captcha_token;
const SHOTS = process.env.SHOTS_DIR || 'test-results';

test('login: widget aparece, botão só libera depois do desafio, token vai no signInWithPassword', async ({ page }) => {
  let token = null;
  page.on('request', (req) => { if (/\/auth\/v1\/token/.test(req.url()) && req.method() === 'POST') token = tokenDe(req); });
  await page.goto('/Login');
  const botao = page.getByRole('button', { name: /^entrar$/i });
  await expect(page.getByTestId('turnstile-widget')).toBeVisible();
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await expect(botao).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/login-claro.png` });
  await entrar(page, 'fornecedor');
  expect(token).toBe(DUMMY);
});

testSemVigia('login: Supabase recusa o CAPTCHA -> mensagem e desafio reiniciado', async ({ page }) => {
  let chamadas = 0;
  await page.route('**/auth/v1/token**', (route) => {
    chamadas++;
    return route.fulfill({ status: 400, contentType: 'application/json',
      body: JSON.stringify({ code: 400, error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (timeout-or-duplicate)' }) });
  });
  await page.goto('/Login');
  await page.getByLabel(/e-?mail/i).fill('alguem@empresa.com');
  await page.getByLabel('Senha', { exact: true }).fill('Senha12345');
  const botao = page.getByRole('button', { name: /^entrar$/i });
  await botao.click();
  await expect(page.getByText(/verificação de segurança falhou ou expirou/i)).toBeVisible();
  // Token de uso único: depois do erro o widget refaz o desafio e libera de novo.
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await expect(botao).toBeEnabled();
  await botao.click();
  await expect.poll(() => chamadas).toBe(2);
});

test('esqueci minha senha: token vai no /recover', async ({ page }) => {
  let token = null;
  await page.route('**/auth/v1/recover**', (route) => { token = tokenDe(route.request()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await page.goto('/Login');
  await page.getByLabel(/e-?mail/i).fill('alguem@empresa.com');
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /esqueci minha senha/i }).click();
  await expect(page.getByText(/enviamos um link para definir uma nova senha/i)).toBeVisible();
  expect(token).toBe(DUMMY);
});

testSemVigia('cadastro: token vai no signUp e a tela de confirmação de e-mail continua igual', async ({ page }) => {
  let token = null;
  await page.route('**/brasilapi.com.br/**', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/viacep.com.br/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"erro":true}' }));
  await page.route('**/auth/v1/signup**', (route) => {
    token = tokenDe(route.request());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'novo@empresa.com',
      identities: [{ id: 'x', provider: 'email' }], user_metadata: {}, app_metadata: {}, created_at: new Date().toISOString(),
    }) });
  });
  await page.goto('/Register');
  await page.getByRole('button', { name: /cliente \/ empreendedor/i }).click();
  await page.getByRole('button', { name: /continuar/i }).click();
  await page.locator('#reg-nome').fill('Teste Turnstile');
  await page.locator('#reg-email').fill('novo@empresa.com');
  await page.locator('#reg-senha').fill('Senha12345');
  await page.locator('#reg-senha2').fill('Senha12345');
  await page.locator('#reg-cnpj').fill('11222333000181');
  await page.locator('#reg-razao').fill('Empresa Teste');
  const finalizar = page.getByRole('button', { name: /finalizar cadastro/i });
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/cadastro.png`, fullPage: true });
  await finalizar.click();
  await expect(page.getByText(/verifique seu e-?mail/i).first()).toBeVisible();
  expect(token).toBe(DUMMY);
});

test('reenvio de confirmação (link expirado): token vai no /resend', async ({ page }) => {
  let token = null;
  await page.route('**/auth/v1/resend**', (route) => { token = tokenDe(route.request()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await page.goto('/ConfirmarEmail');
  const campo = page.getByLabel(/e-mail do cadastro/i);
  await expect(campo).toBeVisible({ timeout: 15000 });
  await campo.fill('alguem@empresa.com');
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /reenviar link de confirmação/i }).click();
  await expect(page.getByText(/um novo link foi enviado/i)).toBeVisible();
  expect(token).toBe(DUMMY);
});

testSemVigia('widget não carrega (bloqueador/rede): avisa, bloqueia o envio e oferece "Tentar de novo"', async ({ page }) => {
  await page.route('**/challenges.cloudflare.com/**', (r) => r.abort());
  await page.goto('/Login');
  await expect(page.getByText(/não foi possível carregar a verificação de segurança/i)).toBeVisible({ timeout: 25000 });
  await expect(page.getByRole('button', { name: /^entrar$/i })).toBeDisabled();
  await expect(page.getByRole('button', { name: /tentar de novo/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/falha-carregamento.png` });
  await page.unroute('**/challenges.cloudflare.com/**');
  await page.getByRole('button', { name: /tentar de novo/i }).click();
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
});

test('tema escuro e celular: widget acompanha o tema e cabe na tela', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('nexar-theme', 'dark'));
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/Login');
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  const largura = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(largura).toBeLessThanOrEqual(375);
  await page.screenshot({ path: `${SHOTS}/login-escuro-celular.png` });
});

testSemVigia('troca de senha em Configurações: widget aparece e o token vai na conferência da senha atual', async ({ page }) => {
  testSemVigia.skip(!CREDENCIAIS.cliente.email, 'sem conta de teste');
  await entrar(page, 'cliente');
  let token = null;
  // Só intercepta a CONFERÊNCIA (senha atual errada de propósito): nada é trocado.
  await page.route('**/auth/v1/token?grant_type=password', (route) => {
    token = tokenDe(route.request());
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }) });
  });
  await page.goto('/Configuracoes');
  await page.getByRole('button', { name: /alterar senha/i }).click();
  await page.locator('#current-password').fill('SenhaErrada1');
  await page.locator('#new-password').fill('NovaSenha123');
  await page.locator('#confirm-password').fill('NovaSenha123');
  await expect(page.getByText('Verificação concluída.')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /salvar nova senha/i }).click();
  await expect(page.getByText('Senha atual incorreta.')).toBeVisible();
  expect(token).toBe(DUMMY);
});
