// Envio de teste da Edge Function send-emails (Resumo.md §222).
//
//   node scripts/email-teste-brevo.mjs
//
// Manda UM e-mail, sempre para EMAIL_TEST_TO (a função ignora qualquer outro
// destino). Não toca na fila nem no banco. Lê a URL do projeto do .env.local
// e o segredo do worker de supabase/functions/.env -- nenhum dos dois é
// impresso.
import fs from 'node:fs';

const ler = (arquivo) => Object.fromEntries(
  fs.readFileSync(new URL(arquivo, import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const app = ler('../.env.local');
const fn = ler('../../Backend/supabase/functions/.env');
if (!app.VITE_SUPABASE_URL) throw new Error('VITE_SUPABASE_URL ausente no .env.local');
if (!fn.EMAIL_WORKER_SECRET || fn.EMAIL_WORKER_SECRET.length < 32) throw new Error('EMAIL_WORKER_SECRET ausente ou curto em supabase/functions/.env');

const res = await fetch(`${app.VITE_SUPABASE_URL}/functions/v1/send-emails`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-email-worker-secret': fn.EMAIL_WORKER_SECRET },
  body: JSON.stringify({ action: 'test' }),
});
const texto = await res.text();
console.log(`HTTP ${res.status}`);
console.log(texto.slice(0, 500));
if (res.status === 404) console.log('-> a função não está publicada (deploy).');
if (res.status === 401) console.log('-> segredo diferente do que está nos secrets da função (rode secrets set de novo).');
if (res.status === 500) console.log('-> EMAIL_WORKER_SECRET ausente/curto nos secrets da função.');
if (res.status === 502 && /ausente|inválido/.test(texto)) console.log('-> configuração incompleta nos secrets da função (nada foi enviado): preencha e rode secrets set de novo.');
else if (res.status === 502) console.log('-> a Brevo recusou: veja "code"/"error" acima e os logs da função no painel.');
