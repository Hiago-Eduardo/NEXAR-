// Banco local (PGlite) montado com as funções, triggers e grants REAIS dos
// arquivos supabase/*.sql, na ordem em que foram aplicados (Resumo.md
// §231-232). Usado pelos ensaios em scripts/ensaio-*.mjs. Nada toca o
// Supabase real.
//
// opções:
//   supabaseDefaultPrivileges: como o Supabase, dá ALL nas tabelas e EXECUTE
//     nas funções criadas DEPOIS da montagem a anon/authenticated/service_role
//     (é o que torna os "revoke" das migrações novas significativos).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(here, "..", "..", "..", "Backend", "supabase");

export async function montarBanco({ supabaseDefaultPrivileges = false } = {}) {
  const { PGlite } = await import(process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : "@electric-sql/pglite");
  const db = new PGlite();

  // ---------------------------------------------------------------- esquema
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, aud text, role text,
      raw_user_meta_data jsonb, raw_app_meta_data jsonb,
      created_at timestamptz default now(), updated_at timestamptz default now());
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;

    create table public.subscriptions (
      id uuid primary key default gen_random_uuid(),
      created_by uuid not null references auth.users(id),
      plan_id text,
      status text not null,
      started_at timestamptz not null default now(),
      expires_at timestamptz not null,
      cancelled_at timestamptz, next_charge_at timestamptz,
      first_cycle_partial boolean default false, partial_days int,
      created_at timestamptz not null default now());
    create unique index subscriptions_one_active on public.subscriptions (created_by) where status = 'active';

    create table public.user_profiles (id uuid primary key default gen_random_uuid(), created_by uuid, user_type text);
    create table public.suppliers (
      id uuid primary key default gen_random_uuid(), created_by uuid, name text, business_name text,
      status text default 'active', plan text, verified boolean default false, featured boolean default false,
      status_before_suspension text, suspended_at timestamptz, suspension_reason text,
      created_at timestamptz default now());
    create table public.products (
      id uuid primary key default gen_random_uuid(), created_by uuid, name text,
      status text not null default 'active', suspended_at timestamptz, suspension_reason text,
      created_at timestamptz default now());
    create table public.product_images (id uuid primary key default gen_random_uuid(), product_id uuid, url text, position int);
    create table public.supplier_images (id uuid primary key default gen_random_uuid(), supplier_id uuid, url text, position int);
  `);

  const ler = (f) => fs.readFileSync(path.join(sqlDir, f), 'utf8');

  // tabelas de pagamento/auditoria: o DDL real de payments-audit-notifications.sql
  for (const m of ler('payments-audit-notifications.sql').matchAll(/^create (?:table|unique index|index) if not exists[\s\S]*?;\s*$/gim)) {
    await db.exec(m[0]);
  }

  await db.exec(`
    do $$ declare t text; begin
      for t in select tablename from pg_tables where schemaname = 'public' loop
        execute format('alter table public.%I enable row level security', t);
        execute format('grant all on public.%I to anon, authenticated, service_role', t);
      end loop;
    end $$;
    create policy "Owners can read own subscriptions" on public.subscriptions for select to authenticated
      using (auth.uid() = created_by or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
    create policy "Owners read own payments" on public.payments for select to authenticated using (auth.uid() = created_by);
    create policy "Owners read own payment methods" on public.payment_methods for select to authenticated using (auth.uid() = created_by);
    create policy "Owners delete own payment methods" on public.payment_methods for delete to authenticated using (auth.uid() = created_by);
    create policy "Owners read own subscription events" on public.subscription_events for select to authenticated using (auth.uid() = created_by);
    create policy "Owners read own notifications" on public.notifications for select to authenticated using (auth.uid() = created_by);
    create policy own_sup on public.suppliers for all to authenticated using (auth.uid() = created_by) with check (auth.uid() = created_by);
    create policy pub_sup on public.suppliers for select to anon, authenticated using (status = 'active');
    create policy own_prod on public.products for all to authenticated using (auth.uid() = created_by) with check (auth.uid() = created_by);
    set check_function_bodies = off;
  `);

  // ------------------------------------- funções/triggers/grants REAIS do repo
  const ORDEM = [
    'rls-policies.sql', 'product-catalog.sql', 'subscription-plan-change.sql', 'plan-change-at-period-end.sql',
    'cancel-clears-scheduled-change.sql', 'billing-cycle-day-10.sql', 'payments-audit-notifications.sql',
    'supplier-plan-sync.sql', 'plan-limits-hardening.sql', 'plan-limits-central.sql', 'plan-limits-ux.sql',
    'fix-downgrade-ended-notification.sql',
  ];

  function blocosDeFuncao(sql) {
    const out = [];
    for (const m of sql.matchAll(/^create or replace (?:function|procedure) public\.\w+\s*\(/gim)) {
      const abre = /\$(\w*)\$/g;
      abre.lastIndex = m.index;
      const a = abre.exec(sql);
      const fecha = sql.indexOf(a[0], a.index + a[0].length);
      const fim = sql.indexOf(';', fecha + a[0].length);
      out.push(sql.slice(m.index, fim + 1));
    }
    return out;
  }

  const puladas = [];
  for (const f of ORDEM) {
    const sql = ler(f);
    for (const b of blocosDeFuncao(sql)) {
      try { await db.exec(b); } catch (e) { puladas.push(`${f}: ${b.slice(27, 80).split('(')[0]} (${e.message})`); }
    }
    for (const m of sql.matchAll(/^(?:drop trigger if exists [^;]+;|create trigger [\s\S]*?;)/gim)) {
      try { await db.exec(m[0]); } catch (e) { puladas.push(`${f}: trigger (${e.message})`); }
    }
    for (const m of sql.matchAll(/^(?:revoke|grant) execute on (?:function|procedure) [^;]+;/gim)) {
      try { await db.exec(m[0]); } catch { /* função de outro arquivo não carregado */ }
    }
  }
  // Padrão do Supabase: authenticated/anon têm EXECUTE explícito em funções
  // novas -- os arquivos revogam o que é interno. Aqui o PUBLIC já cobre.
  await db.exec('set check_function_bodies = on;');
  // Como no banco vivo (diagnóstico de 2026-11-03): anon executa estas três.
  await db.exec('grant execute on function public.cancel_scheduled_plan_change(), public.my_current_subscription(), public.my_scheduled_subscription() to anon;');
  if (puladas.length) console.log('Ignorados ao carregar (não usados no ensaio):\n  ' + puladas.join('\n  '));

  const conta = async (tipo = 'fornecedor') => {
    const r = await db.query(
      `insert into auth.users (id, email, raw_user_meta_data) values (gen_random_uuid(), $1, $2) returning id`,
      [`${tipo}-${Math.random().toString(36).slice(2, 8)}@nexar.test`, { role: tipo }]);
    return r.rows[0].id;
  };
  const como = (uid) => `select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false); set role authenticated;`;
  const tentar = async (sql) => { try { await db.exec(sql); return 'ok'; } catch (e) { return e.message; } finally { await db.exec('reset role;'); } };
  const um = async (sql, p = []) => (await db.query(sql, p)).rows[0];


  if (supabaseDefaultPrivileges) {
    await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  }
  return { db, ler, blocosDeFuncao, conta, como, tentar, um, ORDEM, puladas };
}
