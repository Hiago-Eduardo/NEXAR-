-- ==========================================================================
-- MARCA ESTE BANCO COMO O PROJETO DE TESTE DO SANDBOX (Resumo.md §235)
--
-- Rodar SÓ no projeto de TESTE, logo depois de restaurar o esquema e ANTES
-- de criar qualquer conta. Recusa rodar num banco que já tenha usuários ou
-- assinaturas -- é o caso do projeto principal, onde isto nunca deve existir.
--
-- O marcador é a trava dos passos seguintes: 02-ligar-sandbox.sql e
-- billing-reconcile-cron.sql recusam rodar sem ele. Troque <REF-DO-TESTE>
-- pelo identificador do projeto de teste (só documentação/conferência).
-- Um único bloco DO. RE-EXECUTÁVEL (no mesmo banco de teste).
-- ==========================================================================

do $marca$
declare
  v_ref text := '<REF-DO-TESTE>';
begin
  if v_ref = '<REF-DO-TESTE>' or v_ref !~ '^[a-z0-9]{20}$' then
    raise exception 'Troque <REF-DO-TESTE> pelo ref do projeto de teste (20 caracteres). Nada foi alterado.';
  end if;
  if v_ref = 'tzbawflkcivprblqzqjk' then
    raise exception 'Este é o ref do projeto PRINCIPAL. Nada foi alterado.';
  end if;
  if to_regnamespace('nexar_sandbox') is null then
    if exists (select 1 from auth.users) or exists (select 1 from public.subscriptions) then
      raise exception 'Este banco já tem usuários/assinaturas: não parece um projeto de teste recém-criado. Nada foi alterado.';
    end if;
  end if;

  create schema if not exists nexar_sandbox;
  revoke all on schema nexar_sandbox from public, anon, authenticated;
  create table if not exists nexar_sandbox.marcador (
    id boolean primary key default true check (id),
    project_ref text not null,
    criado_em timestamptz not null default now()
  );
  revoke all on nexar_sandbox.marcador from public, anon, authenticated;
  insert into nexar_sandbox.marcador (project_ref) values (v_ref)
  on conflict (id) do update set project_ref = excluded.project_ref;
end
$marca$;

select 'marcador' as item, project_ref, criado_em from nexar_sandbox.marcador;
