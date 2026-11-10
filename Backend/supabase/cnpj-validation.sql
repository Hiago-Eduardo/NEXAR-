  -- NEXAR -- validação de CNPJ no banco (numérico e alfanumérico de 2026).
  --
  -- ADITIVO: cria 3 funções e 2 triggers novos. Nenhuma função, policy ou
  -- grant existente é alterado; RLS de user_profiles/suppliers continua igual
  -- (cada conta só escreve as próprias linhas). Não toca em suppliers.verified,
  -- plano, assinatura nem catálogo. Ver CONTEXTO.MD/Resumo.md, seção 202.
  --
  -- Por quê: o front (src/lib/cnpj.js) já recusava CNPJ com dígito verificador
  -- errado, mas qualquer cliente com sessão podia gravar direto pela API do
  -- Supabase. Estes triggers repetem a mesma conta no servidor.
  --
  -- Regras (as mesmas do front):
  --  * user_profiles.cnpj: validado no INSERT e quando o valor MUDA. Vazio/null
  --    passa (obrigatoriedade é regra de tela). Um CNPJ antigo inválido que
  --    não muda continua passando -- senão a conta de teste (11.111.111/1111-11)
  --    e perfis de antes da seção 161 não conseguiriam salvar mais nada.
  --  * suppliers.cnpj: validado no INSERT e quando MUDA, mas aceita também o
  --    CNPJ que está no perfil do dono -- o AdEditor grava o CNPJ do perfil no
  --    anúncio, e um perfil antigo inválido não pode travar a publicação.
  --
  -- O algoritmo DUPLICA isValidCNPJ de src/lib/cnpj.js: mudou um, muda o outro.
  -- Cada caractere vale (ASCII - 48): '0'..'9' = 0..9, 'A' = 17 ... 'Z' = 42;
  -- pesos 5,4,3,2,9,8,7,6,5,4,3,2 (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2);
  -- resto < 2 -> 0, senão 11 - resto. Exemplo oficial: 12.ABC.345/01DE-35.
  --
  -- RODAR MANUALMENTE no SQL Editor do Supabase. Idempotente (create or
  -- replace / drop trigger if exists). O bloco de teste no fim só faz assert
  -- em valores fixos, não lê nem grava nenhuma linha.

  begin;

  create or replace function public.cnpj_normalize(p_cnpj text)
  returns text
  language sql
  immutable
  set search_path = public
  as $$
    select regexp_replace(upper(coalesce(p_cnpj, '')), '[^0-9A-Z]', '', 'g');
  $$;

  create or replace function public.cnpj_is_valid(p_cnpj text)
  returns boolean
  language plpgsql
  immutable
  set search_path = public
  as $$
  declare
    c text := public.cnpj_normalize(p_cnpj);
    w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
    w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
    s int;
    r int;
    d1 int;
    d2 int;
  begin
    if c !~ '^[0-9A-Z]{12}[0-9]{2}$' then
      return false;
    end if;
    -- 00000000000000, 11111111111111...: passam na conta, mas não existem.
    if c = repeat(substr(c, 1, 1), 14) then
      return false;
    end if;

    s := 0;
    for i in 1..12 loop
      s := s + (ascii(substr(c, i, 1)) - 48) * w1[i];
    end loop;
    r := s % 11;
    d1 := case when r < 2 then 0 else 11 - r end;

    s := 0;
    for i in 1..12 loop
      s := s + (ascii(substr(c, i, 1)) - 48) * w2[i];
    end loop;
    s := s + d1 * w2[13];
    r := s % 11;
    d2 := case when r < 2 then 0 else 11 - r end;

    return substr(c, 13, 1)::int = d1 and substr(c, 14, 1)::int = d2;
  end;
  $$;

  grant execute on function public.cnpj_normalize(text) to anon, authenticated;
  grant execute on function public.cnpj_is_valid(text) to anon, authenticated;

  -- user_profiles -------------------------------------------------------------

  create or replace function public.enforce_user_profile_cnpj()
  returns trigger
  language plpgsql
  set search_path = public
  as $$
  begin
    if nullif(btrim(coalesce(new.cnpj, '')), '') is null then
      return new;
    end if;
    if tg_op = 'UPDATE' and new.cnpj is not distinct from old.cnpj then
      return new;
    end if;
    if not public.cnpj_is_valid(new.cnpj) then
      raise exception using
        errcode = '23514',
        message = 'CNPJ inválido. Confira os números: os dois últimos dígitos não batem com o resto.';
    end if;
    return new;
  end;
  $$;

  drop trigger if exists trg_enforce_user_profile_cnpj on public.user_profiles;
  create trigger trg_enforce_user_profile_cnpj
  before insert or update of cnpj on public.user_profiles
  for each row execute function public.enforce_user_profile_cnpj();

  -- suppliers -----------------------------------------------------------------

  -- security definer só para ler o CNPJ do perfil do DONO do anúncio (o dono
  -- já lê o próprio perfil pela RLS; o definer cobre admin e funções de
  -- sistema). Não devolve nada: só decide se o write passa.
  create or replace function public.enforce_supplier_cnpj()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $$
  declare
    v_perfil text;
  begin
    if nullif(btrim(coalesce(new.cnpj, '')), '') is null then
      return new;
    end if;
    if tg_op = 'UPDATE' and new.cnpj is not distinct from old.cnpj then
      return new;
    end if;
    if public.cnpj_is_valid(new.cnpj) then
      return new;
    end if;

    select up.cnpj into v_perfil
    from public.user_profiles up
    where up.created_by = new.created_by
    limit 1;

    if v_perfil is not null
      and public.cnpj_normalize(v_perfil) = public.cnpj_normalize(new.cnpj) then
      return new;
    end if;

    raise exception using
      errcode = '23514',
      message = 'CNPJ inválido. Confira os números: os dois últimos dígitos não batem com o resto.';
  end;
  $$;

  revoke execute on function public.enforce_supplier_cnpj() from public, anon, authenticated;

  drop trigger if exists trg_enforce_supplier_cnpj on public.suppliers;
  create trigger trg_enforce_supplier_cnpj
  before insert or update of cnpj on public.suppliers
  for each row execute function public.enforce_supplier_cnpj();

  -- Testes (só valores fixos) -------------------------------------------------
  do $$
  begin
    assert public.cnpj_is_valid('11.222.333/0001-81'), 'numérico válido com máscara';
    assert public.cnpj_is_valid('11222333000181'), 'numérico válido sem máscara';
    assert not public.cnpj_is_valid('11.222.333/0001-82'), 'numérico DV errado';
    assert public.cnpj_is_valid('12.ABC.345/01DE-35'), 'alfanumérico oficial';
    assert public.cnpj_is_valid('12abc34501de35'), 'alfanumérico minúsculo';
    assert not public.cnpj_is_valid('12.ABC.345/01DE-36'), 'alfanumérico DV errado';
    assert not public.cnpj_is_valid('12.ABC.345/01DE-3A'), 'DV com letra';
    assert not public.cnpj_is_valid('11.111.111/1111-11'), 'sequência repetida';
    assert not public.cnpj_is_valid('11.222.333/0001'), 'curto';
    assert not public.cnpj_is_valid(null), 'null';
  end;
  $$;

  commit;

  -- Conferência depois de rodar (leitura):
  --   select tgname from pg_trigger
  --   where tgname in ('trg_enforce_user_profile_cnpj', 'trg_enforce_supplier_cnpj');
  --
  -- Isolamento entre contas (RLS, inalterada): com o JWT da conta A, um
  --   PATCH /rest/v1/user_profiles?id=eq.<id de um perfil da conta B>
  --   { "cnpj": "11.222.333/0001-81" }   (Prefer: return=representation)
  -- deve devolver [] (zero linhas): a policy "Users can update own profile"
  -- filtra as linhas de outras contas antes do trigger.
