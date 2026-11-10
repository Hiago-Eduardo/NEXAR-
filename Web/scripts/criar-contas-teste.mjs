// Recria as contas de teste do .env.local (TEST_FORNECEDOR_* e TEST_CLIENTE_*)
// pelo mesmo caminho do Register: signUp + metadata nexar_profile, e o trigger
// nexar_create_profile_on_signup cria o perfil. A confirmação de e-mail está
// LIGADA no Supabase, então depois rode no SQL Editor:
//   update auth.users set email_confirmed_at = now() where email in (...);
// Uso: node scripts/criar-contas-teste.mjs --confirmo
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { buildSignupMetadata } from '../src/lib/signup.js';

if (!process.argv.includes('--confirmo')) {
  console.error('Escreve no banco compartilhado. Rode com --confirmo.');
  process.exit(1);
}

const env = Object.fromEntries(
  fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const contas = [
  { tipo: 'fornecedor', email: env.TEST_FORNECEDOR_EMAIL, senha: env.TEST_FORNECEDOR_PASSWORD,
    form: { full_name: 'Fornecedor Teste', company_name: '[TESTE] Fornecedor', city: 'São Paulo', state: 'SP' } },
  { tipo: 'cliente', email: env.TEST_CLIENTE_EMAIL, senha: env.TEST_CLIENTE_PASSWORD,
    form: { full_name: 'Cliente Teste', company_name: '[TESTE] Cliente', city: 'São Paulo', state: 'SP' } },
];

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false } });

for (const c of contas) {
  if (!c.email || !c.senha) { console.error(`Faltam credenciais de ${c.tipo} no .env.local`); process.exitCode = 1; continue; }
  const { data, error } = await supabase.auth.signUp({
    email: c.email, password: c.senha,
    options: { data: buildSignupMetadata({ ...c.form, email: c.email }, c.tipo) },
  });
  console.log(c.tipo, c.email, error ? `ERRO: ${error.message}` : `ok (id ${data.user?.id})`);
  if (error) process.exitCode = 1;
}
