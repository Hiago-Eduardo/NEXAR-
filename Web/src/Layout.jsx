import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  Menu, X, Store, MessageSquare, Bell, ChevronDown, LayoutDashboard,
  User as UserIcon, Settings, LogOut, Info,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { hasUsableBenefits } from "@/lib/subscription";

export default function Layout({ children, currentPageName }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { isAuthenticated, user, logout } = useAuth();
  const { toast } = useToast();

  // Foto do usuário para o menu. Ela mora em `user_profiles.avatar_url`, não
  // no user_metadata do Supabase Auth -- por isso precisa desta consulta. Só
  // roda logado, e o staleTime longo faz valer uma vez por sessão em vez de
  // uma vez por página (o Layout monta em todas).
  //
  // A busca tenta pelo uuid e cai no email: é o mesmo par de tentativas que
  // Conta.jsx já fazia, porque dados antigos usam email como identidade.
  const { data: profile } = useQuery({
    queryKey: ["my-profile-avatar", user?.id],
    queryFn: async () => {
      let rows = [];
      if (user?.id) rows = await api.entities.UserProfile.filter({ created_by: user.id });
      if (!rows.length && user?.email) {
        rows = await api.entities.UserProfile.filter({ created_by: user.email });
      }
      return rows[0] || null;
    },
    enabled: isAuthenticated && !!user,
    staleTime: 5 * 60 * 1000,
  });

  // Mesma verificação que o Dashboard faz antes de abrir o AdEditor: sem
  // plano utilizável, o destino é Planos -- e com um aviso, não com um
  // redirecionamento silencioso depois de a página já ter carregado.
  const { data: navSubscription = null } = useQuery({
    queryKey: ["my-subscription", user?.id],
    queryFn: () => api.subscriptions.getCurrent(),
    enabled: isAuthenticated && !!user,
  });
  const canAnnounceNow = hasUsableBenefits(navSubscription);
  const announceTarget = canAnnounceNow
    ? createPageUrl("AdEditor")
    : `${createPageUrl("Planos")}?onboarding=1`;
  const handleAnnounceClick = () => {
    if (!canAnnounceNow) {
      toast({
        title: "Plano necessário",
        description: "Você precisa de um plano ativo para criar anúncios.",
      });
    }
  };

  const avatarUrl = profile?.avatar_url || "";
  const displayName = profile?.full_name || user?.full_name || user?.email || "";
  const initial = (displayName || "?")[0].toUpperCase();

  const isHome = currentPageName === "Home";

  // Na Home o menu começa transparente (sobre o Hero escuro) e devia virar
  // sólido ao rolar -- antes isso nunca acontecia (isHome é fixo por página,
  // não reagia a scroll), então o menu ficava com texto branco/fundo
  // transparente pra sempre, mesmo depois de descer pra uma seção clara
  // (CategoryGrid etc.) -- texto branco sobre fundo branco, invisível.
  const [isScrolled, setIsScrolled] = useState(false);
  useEffect(() => {
    if (!isHome) {
      setIsScrolled(false);
      return;
    }
    const handleScroll = () => setIsScrolled(window.scrollY > 40);
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isHome]);

  const showTransparentNav = isHome && !isScrolled;
  const userRole = user?.role || "user";
  const isFornecedor = userRole === "fornecedor" || userRole === "admin";
  const isCliente = userRole === "cliente" || userRole === "empreendedor" || userRole === "user";
  const canSeeDashboard = isAuthenticated && isFornecedor;
  const canSeeAccount = isAuthenticated && (isFornecedor || isCliente);
  const canSeeAnnounce = isAuthenticated && isFornecedor;
  const canSeeMessages = isAuthenticated && (isFornecedor || isCliente);
  const canSeeNotifications = isAuthenticated && (isFornecedor || isCliente);

  // Contador de notificações do SISTEMA não vistas (seção 155). Conta só a
  // tabela notifications; mensagens de chat têm o próprio contador, logo
  // abaixo, ao lado de "Mensagens" (seção 156) -- cada número zera no lugar
  // onde a pessoa resolve aquilo. A tela de Notificações marca tudo como
  // visto ao abrir e invalida esta query, então o número some na hora.
  //
  // 30s + foco na aba: o padrão global é refetchOnWindowFocus: false, mas
  // aqui voltar para a aba é justamente quando a pessoa quer saber se chegou
  // algo.
  const { data: unreadCount = 0 } = useQuery({
    queryKey: ["notifications-unread", user?.id],
    queryFn: () => api.notifications.unreadCount(),
    enabled: canSeeNotifications && !!user?.id,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
  });
  const hasUnread = canSeeNotifications && unreadCount > 0;
  const unreadLabel = badgeLabel(unreadCount);
  const notificationsAriaLabel = hasUnread
    ? `Notificações, ${unreadCount} não ${unreadCount === 1 ? "lida" : "lidas"}`
    : "Notificações";

  // Mensagens de chat recebidas e não lidas (supabase/chat-read-receipts.sql).
  // Zera quando a pessoa abre a conversa no Chat. retry: false porque, se o
  // SQL ainda não foi rodado, a RPC não existe -- sem badge é o resultado
  // certo, e insistir só gera erro repetido no console.
  const { data: unreadMessages = 0 } = useQuery({
    queryKey: ["chat-unread", user?.id],
    queryFn: () => api.chat.unreadCount(),
    enabled: canSeeMessages && !!user?.id,
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  const hasUnreadMessages = canSeeMessages && unreadMessages > 0;
  const messagesAriaLabel = hasUnreadMessages
    ? `Mensagens, ${unreadMessages} não ${unreadMessages === 1 ? "lida" : "lidas"}`
    : "Mensagens";
  const hasAnythingUnread = hasUnread || hasUnreadMessages;

  return (
    <div className="min-h-screen">
      {/* Navigation */}
      <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        showTransparentNav ? "bg-transparent" : "bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-100 dark:border-slate-800"
      }`}>
        <div className="max-w-site mx-auto px-6 h-16 flex items-center justify-between">
          <Link to={createPageUrl("Home")} className="flex items-center gap-2">
            <span className={`font-display text-xl font-black tracking-widest ${showTransparentNav ? "text-white" : "text-slate-900 dark:text-slate-50"}`}>
              NE<span className="text-orange-500">X</span>AR
            </span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            <Link
              to={createPageUrl("Home")}
              className={`text-sm font-medium transition-colors hover:text-orange-500 ${
                showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
              }`}
            >
              Início
            </Link>
            <Link
              to={createPageUrl("Suppliers")}
              className={`text-sm font-medium transition-colors hover:text-orange-500 ${
                showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
              }`}
            >
              Fornecedores
            </Link>
            <Link
              to={createPageUrl("Planos")}
              className={`text-sm font-medium transition-colors hover:text-orange-500 ${
                showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
              }`}
            >
              Planos
            </Link>
            {/* "Sobre" saiu daqui e foi para o menu do usuário (seção 113).
                No mobile ele CONTINUA na lista principal, porque lá não
                existe menu do usuário separado -- e é por lá que o visitante
                sem conta chega à página. No desktop, quem não tem conta chega
                pelo rodapé. */}
            {canSeeMessages ? (
              <Link
                to={createPageUrl("Chat")}
                aria-label={messagesAriaLabel}
                className={`inline-flex items-center text-sm font-medium transition-colors hover:text-orange-500 ${
                  showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
                }`}
              >
                <MessageSquare className={`w-4 h-4 mr-1 ${hasUnreadMessages ? "text-orange-500 fill-orange-500" : ""}`} />
                Mensagens
                {hasUnreadMessages && <UnreadBadge label={badgeLabel(unreadMessages)} />}
              </Link>
            ) : null}

            {canSeeNotifications ? (
              <Link
                to={createPageUrl("Notificacoes")}
                aria-label={notificationsAriaLabel}
                className={`inline-flex items-center text-sm font-medium transition-colors hover:text-orange-500 ${
                  showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
                }`}
              >
                <Bell className={`w-4 h-4 mr-1 ${hasUnread ? "text-orange-500 fill-orange-500" : ""}`} />
                Notificações
                {hasUnread && <UnreadBadge label={unreadLabel} />}
              </Link>
            ) : null}

            {isAuthenticated ? (
              <>
                {/* "Meu painel" voltou para a barra principal, ANTES do
                    "Anunciar" (seção 113) -- é o destino mais visitado de quem
                    tem conta e estava escondido atrás do menu suspenso. Saiu do
                    menu do usuário no mesmo movimento: dois caminhos para o
                    mesmo lugar foi exatamente o problema do "Admin" na seção 91
                    e do "Anunciar" duplicado na seção 92. */}
                {canSeeDashboard && (
                  <Link
                    to={createPageUrl("Dashboard")}
                    className={`text-sm font-medium transition-colors hover:text-orange-500 ${
                      showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
                    }`}
                  >
                    <LayoutDashboard className="mr-1 inline h-4 w-4" />
                    Meu painel
                  </Link>
                )}

                {canSeeAnnounce && (
                  /* Antes este botão ia direto para o AdEditor mesmo sem
                     plano ativo -- e o AdEditor então fazia
                     `window.location.href` para Planos: recarga da página
                     inteira, sem explicar nada, com a tela piscando.
                     O botão do Dashboard já avisava antes e navegava sem
                     recarregar; agora os dois se comportam igual
                     (ver Resumo.md seção 92). */
                  <Link to={announceTarget} onClick={handleAnnounceClick}>
                    <Button
                      size="sm"
                      className="rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600"
                    >
                      <Store className="w-4 h-4 mr-1.5" />
                      Anunciar
                    </Button>
                  </Link>
                )}

                {/* Menu do usuário (ver Resumo.md seção 91).
                    Antes "Meu Painel", "Minha Conta" e "Admin" ficavam soltos
                    na barra -- que chegava a 8 itens em linha -- e NÃO HAVIA
                    BOTÃO DE SAIR em lugar nenhum da navegação: o logout só
                    existia dentro de /Conta, onde ninguém procura.
                    "Admin" também apontava para o MESMO destino de "Meu
                    Painel", então virava um item duplicado. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={`flex items-center gap-2 text-sm font-medium transition-colors hover:text-orange-500 ${
                        showTransparentNav ? "text-white/80" : "text-slate-600 dark:text-slate-300"
                      }`}
                    >
                      {/* Foto quando existe; inicial em pastilha laranja
                          como reserva. Mesmo tamanho nos dois casos, para o
                          menu não "pular" quando a imagem carrega. */}
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt=""
                          className="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-black/10"
                        />
                      ) : (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500 text-xs font-bold text-white">
                          {initial}
                        </span>
                      )}
                      <span className="max-w-[9rem] truncate">{displayName}</span>
                      <ChevronDown className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52 rounded-card">
                    {/* "Meu painel" saiu daqui e foi para a barra principal
                        (seção 113) -- não pode ficar nos dois lugares. */}
                    {canSeeAccount && (
                      <DropdownMenuItem asChild>
                        <Link to={createPageUrl("Conta")} className="cursor-pointer gap-2">
                          <UserIcon className="h-4 w-4" />
                          Minha conta
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {/* Configurações só era alcançável de dentro de /Conta */}
                    <DropdownMenuItem asChild>
                      <Link to={createPageUrl("Configuracoes")} className="cursor-pointer gap-2">
                        <Settings className="h-4 w-4" />
                        Configurações
                      </Link>
                    </DropdownMenuItem>
                    {/* "Sobre" veio da barra principal (seção 113). Separador
                        antes porque é de outra natureza: os itens acima são a
                        CONTA da pessoa, este é institucional. */}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to={createPageUrl("Sobre")} className="cursor-pointer gap-2">
                        <Info className="h-4 w-4" />
                        Sobre o NEXAR
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => logout()}
                      className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                    >
                      <LogOut className="h-4 w-4" />
                      Sair
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <Link to={createPageUrl("Login")}>
                <Button
                  size="sm"
                  className="rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600"
                >
                  Entrar / Cadastrar
                </Button>
              </Link>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={hasAnythingUnread ? `Menu, há itens não lidos` : "Menu"}
            className={`relative md:hidden p-2 ${showTransparentNav ? "text-white" : "text-slate-700 dark:text-slate-300"}`}
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            {/* No celular os links de Mensagens e Notificações ficam
                escondidos no menu fechado -- o ponto no ícone é o único
                aviso visível. */}
            {hasAnythingUnread && !mobileMenuOpen && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-orange-500 ring-2 ring-white dark:ring-slate-900" />
            )}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 shadow-lg">
            <div className="px-6 py-4 space-y-3">
              <Link
                to={createPageUrl("Home")}
                onClick={() => setMobileMenuOpen(false)}
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2"
              >
                Início
              </Link>
              <Link
                to={createPageUrl("Suppliers")}
                onClick={() => setMobileMenuOpen(false)}
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2"
              >
                Fornecedores
              </Link>
              <Link to={createPageUrl("Planos")} onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                Planos
              </Link>
              <Link to={createPageUrl("Sobre")} onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                Sobre
              </Link>
              {canSeeMessages ? (
                <Link to={createPageUrl("Chat")} onClick={() => setMobileMenuOpen(false)} aria-label={messagesAriaLabel} className="flex items-center text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                  <MessageSquare className={`w-4 h-4 mr-1 ${hasUnreadMessages ? "text-orange-500 fill-orange-500" : ""}`} /> Mensagens
                  {hasUnreadMessages && <UnreadBadge label={badgeLabel(unreadMessages)} />}
                </Link>
              ) : null}

              {canSeeNotifications ? (
                <Link to={createPageUrl("Notificacoes")} onClick={() => setMobileMenuOpen(false)} aria-label={notificationsAriaLabel} className="flex items-center text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                  <Bell className={`w-4 h-4 mr-1 ${hasUnread ? "text-orange-500 fill-orange-500" : ""}`} /> Notificações
                  {hasUnread && <UnreadBadge label={unreadLabel} />}
                </Link>
              ) : null}

              {isAuthenticated ? (
                <>
                  {canSeeDashboard && (
                    <Link to={createPageUrl("Dashboard")} onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                      Meu Painel
                    </Link>
                  )}
                  {canSeeAccount && (
                    <Link to={createPageUrl("Conta")} onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                      Minha Conta
                    </Link>
                  )}
                  <Link to={createPageUrl("Configuracoes")} onClick={() => setMobileMenuOpen(false)} className="block text-sm font-medium text-slate-700 dark:text-slate-300 py-2">
                    Configurações
                  </Link>
                  {canSeeAnnounce && (
                    <Link
                      to={announceTarget}
                      onClick={() => { setMobileMenuOpen(false); handleAnnounceClick(); }}
                    >
                      <Button size="sm" className="w-full rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600">
                        <Store className="w-4 h-4 mr-1.5" />
                        Anunciar
                      </Button>
                    </Link>
                  )}
                  {/* "Sair" também faltava aqui -- no celular o logout era
                      igualmente inalcançável fora de /Conta. */}
                  <button
                    type="button"
                    onClick={() => { setMobileMenuOpen(false); logout(); }}
                    className="flex w-full items-center gap-2 py-2 text-sm font-medium text-destructive"
                  >
                    <LogOut className="h-4 w-4" />
                    Sair
                  </button>
                </>
              ) : (
                <Link to={createPageUrl("Login")} onClick={() => setMobileMenuOpen(false)}>
                  <Button size="sm" className="w-full rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600">
                    <Store className="w-4 h-4 mr-1.5" />
                    Entrar / Cadastrar
                  </Button>
                </Link>
              )}
            </div>
          </div>
        )}
      </nav>

      {/* Page content */}
      <main className={isHome ? "" : "pt-16"}>
        {children}
      </main>
    </div>
  );
}

// Número de não lidas ao lado de "Mensagens" e "Notificações". Laranja cheio com texto
// branco: é o único elemento da barra que pede ação, e a cor da marca já é o
// que o site usa para "isto é seu e é novo" (o ponto nos itens da tela).
function badgeLabel(count) {
  return count > 9 ? "9+" : String(count);
}

function UnreadBadge({ label }) {
  return (
    <span aria-hidden="true" className="tnum ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-orange-500 px-1.5 text-[11px] font-semibold leading-none text-white">
      {label}
    </span>
  );
}
