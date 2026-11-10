// Chaves do Supabase dentro das Edge Functions (Resumo.md §236).
//
// Projetos antigos injetam SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
// ("legadas", que valem até o fim de 2026). Projetos novos injetam
// SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS: um JSON com as chaves
// por nome, a padrão em "default". Docs:
// https://supabase.com/docs/guides/functions/secrets
// Este leitor usa a legada quando existe e, senão, a "default" nova -- o
// mesmo código roda no principal e no projeto de teste.

function fromJson(raw, name = "default") {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw)?.[name];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** @returns {{ url: string, publicKey: string|null, serviceKey: string|null }} */
export function supabaseKeys(env) {
  const get = (k) => (typeof env?.get === "function" ? env.get(k) : env?.[k]) ?? "";
  return {
    url: get("SUPABASE_URL"),
    publicKey: get("SUPABASE_ANON_KEY") || fromJson(get("SUPABASE_PUBLISHABLE_KEYS")),
    serviceKey: get("SUPABASE_SERVICE_ROLE_KEY") || fromJson(get("SUPABASE_SECRET_KEYS")),
  };
}
