import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { api, supabase } from '@/api/client';
import { queryClientInstance } from '@/lib/query-client';

const AuthContext = createContext();

// Mesmo usuário, mesmos dados -> mesmo objeto. O Supabase manda SIGNED_IN /
// TOKEN_REFRESHED várias vezes depois do login e de novo a cada vez que a aba
// volta ao foco; cada um virava um `user` novo, e toda página com efeito em
// [user] recarregava -- em Minha Conta isso apagava o que a pessoa estava
// digitando (seção 204). Só troca o objeto quando algum campo muda de fato.
const USER_FIELDS = ['id', 'email', 'full_name', 'role', 'active_plan'];
function keepIfSame(prev, next) {
  if (prev && next && USER_FIELDS.every((k) => prev[k] === next[k])) return prev;
  return next;
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [appPublicSettings, setAppPublicSettings] = useState(null); // Contains only { id, public_settings }

  const checkUserAuth = useCallback(async () => {
    try {
      setIsLoadingAuth(true);
      setAuthError(null);

      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;

      if (!data.session) {
        setUser(null);
        setIsAuthenticated(false);
        setAuthChecked(true);
        setIsLoadingAuth(false);
        return null;
      }

      const currentUser = await api.auth.me();
      setUser((prev) => keepIfSame(prev, currentUser));
      setIsAuthenticated(true);
      setAuthChecked(true);
      setIsLoadingAuth(false);
      return currentUser;
    } catch (error) {
      console.error('User auth check failed:', error);
      setIsLoadingAuth(false);
      setIsAuthenticated(false);
      setAuthChecked(true);
      setAuthError({
        type: 'auth_required',
        message: error.message || 'Authentication required'
      });
      return null;
    }
  }, []);

  const checkAppState = useCallback(async () => {
    setIsLoadingPublicSettings(true);
    setAppPublicSettings({ id: 'supabase', public_settings: {} });
    setIsLoadingPublicSettings(false);
    return checkUserAuth();
  }, [checkUserAuth]);

  useEffect(() => {
    checkAppState();
  }, [checkAppState]);

  // Mantém `user`/`isAuthenticated` em dia sem depender de um F5: dispara em qualquer
  // login/logout/troca de conta feita nesta aba, mesmo quando a navegação (React Router)
  // não desmonta a página atual e o efeito de carregamento dela não rodaria de novo sozinho.
  const refreshUserSilently = useCallback(async () => {
    try {
      const currentUser = await api.auth.me();
      setUser((prev) => keepIfSame(prev, currentUser));
      setIsAuthenticated(true);
      setAuthChecked(true);
    } catch {
      setUser(null);
      setIsAuthenticated(false);
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'INITIAL_SESSION') return; // já coberto pelo checkAppState() de montagem
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setIsAuthenticated(false);
        setAuthChecked(true);
        return;
      }
      // SIGNED_IN, USER_UPDATED, TOKEN_REFRESHED, etc. — atualiza sem mexer em
      // isLoadingAuth para não piscar uma tela de carregamento no app inteiro a cada
      // renovação silenciosa de token.
      refreshUserSilently();
    });
    return () => subscription.unsubscribe();
  }, [refreshUserSilently]);

  // Ao trocar de conta (ou logout), nenhuma query do React Query deve continuar servindo
  // dado da conta anterior — mesmo para telas que não dependem diretamente do `user` daqui.
  //
  // O `authChecked` NÃO é decoração: sem ele este efeito limpava o cache em TODO
  // carregamento de página de usuário logado. A primeira passada acontecia antes de a
  // sessão resolver, com `user` ainda null, e semeava a ref com null; quando o auth
  // resolvia e o id aparecia, a transição null -> uuid era lida como troca de conta.
  // O clear caía logo DEPOIS de as queries da página terem começado, e toda query com
  // `initialData` voltava como valor inicial em estado "success" -- sem refetch, porque
  // refetchOnMount só vale na montagem do observer, não quando o cache é esvaziado por
  // baixo dele. Era assim que a lista de avaliações do SupplierProfile ficava
  // permanentemente vazia enquanto a nota do anúncio aparecia normal (a query do
  // supplier não tem initialData e ainda por cima muda de chave quando o login resolve).
  // Ver CONTEXTO.MD/Resumo.md seção 103.
  //
  // Esperando o authChecked, a primeira observação já é a do estado resolvido, então a
  // subida inicial de null para o id nunca conta como troca. Login, logout e troca de
  // conta durante o uso continuam limpando, que é o motivo de o efeito existir.
  const previousUserIdRef = useRef(undefined);
  useEffect(() => {
    if (!authChecked) return;

    const currentId = user?.id ?? null;
    if (previousUserIdRef.current === undefined) {
      previousUserIdRef.current = currentId;
      return;
    }
    if (currentId !== previousUserIdRef.current) {
      queryClientInstance.clear();
    }
    previousUserIdRef.current = currentId;
  }, [user?.id, authChecked]);

  const logout = useCallback((shouldRedirect = true) => {
    setUser(null);
    setIsAuthenticated(false);
    setAuthChecked(true);
    void api.auth.logout(shouldRedirect ? '/' : undefined);
  }, []);

  const navigateToLogin = useCallback(() => {
    api.auth.redirectToLogin(window.location.href);
  }, []);

  return (
    <AuthContext.Provider value={{ 
      user, 
      isAuthenticated, 
      isLoadingAuth,
      isLoadingPublicSettings,
      authChecked,
      authError,
      appPublicSettings,
      logout,
      navigateToLogin,
      checkAppState
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
