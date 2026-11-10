import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  logLevel: 'error', // Suppress warnings, only show errors
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
  plugins: [
    react(),
  ],
  // Vitest (`npm test`). Ver CONTEXTO.MD/Resumo.md seção 106.
  //
  // `environment: 'node'` de propósito: os testes que existem hoje batem na
  // camada de dados (src/api/client.js) e em helpers puros, nada de DOM. No
  // dia em que houver teste de componente, aí sim entram jsdom e
  // @testing-library -- não antes, para o `npm test` continuar rápido.
  //
  // Só VITE_ chega ao navegador (envPrefix padrão). Até 2026-11-09 o
  // envPrefix incluía TEST_, e o dev server mandava os e-mails/senhas das
  // contas de teste para o navegador em import.meta.env (§241) -- e um
  // build com TEST_* no .env os embutiria no bundle (turnstile.js usa o
  // objeto import.meta.env inteiro). Os testes e o e2e leem TEST_* direto
  // do .env.local (subscription-flow.banco.test.js, e2e/helpers.js).
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
    // Testes de integração conversam com o Supabase real; o padrão de 5s
    // estoura em rede lenta e produz falha falsa.
    testTimeout: 20000,
  },
  envPrefix: ['VITE_'],
});
