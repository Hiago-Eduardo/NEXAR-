// Identificador anônimo persistido no navegador, usado só para deduplicar visualizações
// de anúncio de visitantes não logados (ver register_ad_view em supabase/rls-policies.sql).
// Nunca é combinado com IP ou fingerprint — é só um UUID opaco guardado localmente.
const STORAGE_KEY = "nexar_visitor_id";

export function getOrCreateVisitorSessionId() {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;

    const generated = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, generated);
    return generated;
  } catch {
    // Modo privado, storage bloqueado, etc. — visitante anônimo simplesmente não
    // gera visualização nesse caso (ver chamador em SupplierProfile.jsx).
    return null;
  }
}
