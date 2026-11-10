import React, { useEffect, useRef, useState } from "react";
import { Bell, ArrowLeft, CheckCircle2, Clock3, MessageSquareText, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { isReceivedChatMessage } from "@/lib/chat";

const typeColors = {
  success: "bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-900/50",
  message: "bg-orange-50 text-orange-600 border-orange-100 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-900/50",
  // `info` era azul-celeste; virou neutro quente. Informação sem urgência não
  // precisa de cor própria, e o azul destoava da paleta (seção 78).
  info: "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
};

export default function Notificacoes() {
  const { user, authChecked } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Deslogado a tela dizia "Nada por aqui ainda." -- como se a pessoa não
  // tivesse avisos. Pede login, como Conta/Configurações.
  useEffect(() => {
    if (authChecked && !user) api.auth.redirectToLogin("/Notificacoes");
  }, [authChecked, user]);

  const { data: userMessages = [], isLoading, isError } = useQuery({
    queryKey: ["notification-messages", user?.email],
    queryFn: () => api.entities.ChatMessage.listForCurrentUser("-created_date", 100),
    enabled: !!user?.email,
    refetchInterval: 5000,
  });

  // A OUTRA FONTE, nova desde a seção 130: notificações do SISTEMA (troca de
  // plano, cancelamento, suspensão), gravadas por trigger no banco.
  //
  // Esta tela sempre se chamou "central de notificações" mas mostrava só
  // mensagens de chat -- era uma caixa de entrada com um remetente só. Agora
  // são duas fontes, fundidas por data, cada uma com seu destino ao clicar.
  const { data: sistema = [], isFetchedAfterMount, isLoading: carregandoSistema, isError: erroSistema } = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: () => api.notifications.list(50),
    enabled: !!user?.id,
  });

  // ABRIR A TELA = VER (seção 155). Assim que a lista chega, tudo que estava
  // não lido é marcado como lido no banco, e o contador da NavBar zera.
  //
  // Mas o DESTAQUE fica: `novasNestaVisita` guarda os ids que chegaram não
  // lidos, e eles continuam com fundo laranja até a pessoa sair da tela. Sem
  // isso, o número some e a pessoa não sabe QUAIS eram as novas.
  //
  // isFetchedAfterMount, e não só `sistema`: na segunda visita o React Query
  // entrega primeiro o cache da visita anterior, onde as já vistas ainda
  // aparecem sem read_at -- elas voltariam a ser destacadas como novas.
  const [novasNestaVisita, setNovasNestaVisita] = useState(() => new Set());
  const jaMarcou = useRef(false);
  useEffect(() => {
    if (!isFetchedAfterMount || jaMarcou.current) return;
    jaMarcou.current = true;
    const naoVistas = sistema.filter((n) => !n.read_at).map((n) => n.id);
    if (naoVistas.length === 0) return;
    setNovasNestaVisita(new Set(naoVistas));
    api.notifications.markAllRead()
      .then(() => queryClient.invalidateQueries({ queryKey: ["notifications-unread"] }))
      .catch(() => {
        // Falhou ao marcar: o contador da NavBar continua, o que é o
        // comportamento honesto -- a pessoa não perde o aviso.
      });
  }, [isFetchedAfterMount, sistema, queryClient]);

  // As duas fontes da tela: avisos do sistema E mensagens de chat recebidas
  // (seção 156). Antes só marcava o sistema, e o botão nunca sumia enquanto
  // houvesse mensagem recebida. O chat vai com catch próprio: se
  // chat-read-receipts.sql ainda não foi rodado, o sistema é marcado mesmo assim.
  const marcarTodasLidas = async () => {
    try {
      await Promise.all([
        api.notifications.markAllRead(),
        api.chat.markAllRead().catch(() => 0),
      ]);
    } catch (error) {
      // Antes a falha virava erro solto no console e o botão não respondia.
      toast({
        title: "Não foi possível marcar como lidas",
        description: error.message || "Tente novamente.",
        variant: "destructive",
      });
      return;
    }
    setNovasNestaVisita(new Set());
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["notifications-unread"] });
    queryClient.invalidateQueries({ queryKey: ["notification-messages"] });
    queryClient.invalidateQueries({ queryKey: ["chat-unread"] });
    queryClient.invalidateQueries({ queryKey: ["user-messages"] });
  };

  const doSistema = sistema.map((n) => ({
    id: `sys-${n.id}`,
    title: n.title,
    message: n.body,
    time: new Date(n.created_at).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    }),
    quando: new Date(n.created_at).getTime(),
    // 'success' para o que confirma algo que a pessoa quis; 'info' para o
    // resto. Suspensão e encerramento NÃO são verdes: a cor tem que dizer a
    // mesma coisa que o texto.
    type: ["subscription_started", "subscription_reactivated", "plan_change_applied", "plan_limits_restored"].includes(n.type)
      ? "success"
      : "info",
    read: !!n.read_at && !novasNestaVisita.has(n.id),
    destino: n.link || createPageUrl("Dashboard"),
  }));

  // Só as RECEBIDAS. Cada mensagem que a própria pessoa mandava também virava
  // um item ("Mensagem enviada") -- uma conversa de 20 mensagens enchia a
  // central com o que ela mesma escreveu. `filter` também evita o `sort`
  // mexer no array que está no cache do React Query.
  const deChat = userMessages
    .filter((item) => isReceivedChatMessage(item, user))
    .sort((first, second) => new Date(second.created_at || second.created_date) - new Date(first.created_at || first.created_date))
    .map((item) => {
      // Pela conta (seção 166): na conversa de anúncio o receiver_id é o id do
      // anúncio, não o e-mail do dono.
      const otherId = item.sender_id;
      const otherName = item.sender_name;
      return {
        ...item,
        title: "Nova mensagem recebida",
        message: item.message,
        time: new Date(item.created_at || item.created_date).toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
        quando: new Date(item.created_at || item.created_date).getTime(),
        type: "message",
        read: item.read === true,
        // ad_id junto: sem ele, a resposta do dono do anúncio não saía como o
        // anúncio e levava o e-mail de login dele ao cliente (seção 169).
        destino: `${createPageUrl("Chat")}?conversation_id=${encodeURIComponent(item.conversation_id)}&with=${encodeURIComponent(otherName || otherId || "Conversa")}&supplier_id=${encodeURIComponent(otherId || "")}${item.ad_id ? `&ad_id=${encodeURIComponent(item.ad_id)}` : ""}`,
      };
    });

  // Fundidas e reordenadas juntas: uma caixa de entrada onde as duas fontes
  // se intercalam por data, não dois blocos separados que obrigam a pessoa a
  // olhar em dois lugares para saber o que aconteceu primeiro.
  const notifications = [...doSistema, ...deChat].sort((a, b) => b.quando - a.quando);
  const naoLidas = notifications.filter((n) => !n.read).length;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link to={createPageUrl("Home")}>
              <Button variant="ghost" size="sm" className="gap-2 text-slate-600 dark:text-slate-400">
                <ArrowLeft className="w-4 h-4" />
                Voltar
              </Button>
            </Link>
          </div>
          <div className="flex items-center gap-2 text-slate-900 dark:text-slate-50 font-semibold">
            <Bell className="w-5 h-5 text-orange-500" />
            Notificações
          </div>
        </div>

        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="w-5 h-5 text-orange-500" />
                Central de notificações
              </CardTitle>
              {/* So aparece quando ha o que marcar -- botao permanentemente
                  desabilitado e ruido que a pessoa aprende a ignorar. */}
              {naoLidas > 0 && (
                <Button variant="ghost" size="sm" onClick={marcarTodasLidas} className="text-slate-500 dark:text-slate-400">
                  Marcar todas como lidas
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {(isLoading || carregandoSistema) && <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">Carregando notificações...</p>}
            {(isError || erroSistema) && <p className="py-8 text-center text-sm text-red-500 dark:text-red-400">Não foi possível carregar suas notificações.</p>}
            {!isLoading && !carregandoSistema && !isError && !erroSistema && notifications.length === 0 && (
              <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">Nada por aqui ainda.</p>
            )}
            {!isLoading && !carregandoSistema && !isError && !erroSistema && notifications.map((item) => (
              <Link
                key={item.id}
                to={item.destino}
                className={`flex items-start gap-3 rounded-card border p-4 ${item.read ? "bg-white border-slate-100 dark:bg-slate-900 dark:border-slate-800" : "bg-orange-50/60 border-orange-100 dark:bg-orange-500/10 dark:border-orange-900/50"}`}
              >
                <div className={`mt-0.5 rounded-full border p-2 ${typeColors[item.type]}`}>
                  {item.type === "success" ? <CheckCircle2 className="w-4 h-4" /> : item.type === "message" ? <MessageSquareText className="w-4 h-4" /> : <Clock3 className="w-4 h-4" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-800 dark:text-slate-100">{item.title}</p>
                    {!item.read && (
                      <span className="inline-flex h-2.5 w-2.5 rounded-full bg-orange-500">
                        <span className="sr-only">Não lida</span>
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.message}</p>
                  <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{item.time}</p>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
