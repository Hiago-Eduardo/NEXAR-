import React, { useState, useEffect, useRef } from "react";
import { api } from "@/api/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Send, ImagePlus, Loader2, MessageSquare, ArrowLeft, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useToast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/AuthContext";
import { isOwnChatMessage, isReceivedChatMessage } from "@/lib/chat";

function ConversationItem({ conv, isActive, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-card transition-all ${
        isActive ? "border border-orange-200 bg-orange-50 dark:border-orange-500/30 dark:bg-orange-500/10" : "hover:bg-slate-50 dark:hover:bg-slate-800/60 border border-transparent"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
          {conv.with_name?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 dark:text-slate-100 text-sm truncate">{conv.with_name}</p>
          <p className={`text-xs truncate ${conv.unread > 0 ? "font-medium text-slate-700 dark:text-slate-200" : "text-slate-400 dark:text-slate-500"}`}>{conv.last_message}</p>
        </div>
        {conv.unread > 0 && (
          <span
            aria-label={`${conv.unread} não ${conv.unread === 1 ? "lida" : "lidas"}`}
            className="tnum inline-flex h-5 min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-orange-500 px-1.5 text-[11px] font-semibold leading-none text-white"
          >
            {conv.unread > 9 ? "9+" : conv.unread}
          </span>
        )}
      </div>
    </button>
  );
}

// Só a hora deixava ambíguo "ontem às 14:00" x "hoje às 14:00": fora de hoje,
// vai a data junto.
function formatMessageTime(value) {
  const date = new Date(value);
  const hora = date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return hora;
  return `${date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora}`;
}

function MessageBubble({ message, currentUser }) {
  // Pela conta, não pelo e-mail: a resposta do dono de um anúncio sai com
  // sender_id = id do anúncio (seção 166) e seria desenhada como "do outro".
  const isOwn = isOwnChatMessage(message, currentUser);
  return (
    <div className={`flex ${isOwn ? "justify-end" : "justify-start"} mb-3`}>
      <div className={`max-w-[75%] ${isOwn ? "order-1" : ""}`}>
        {!isOwn && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mb-1 ml-1">{message.sender_name}</p>
        )}
        <div className={`rounded-card px-4 py-2.5 ${
          isOwn
            ? "rounded-br-md bg-orange-500 text-white"
            : "bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-bl-md shadow-sm"
        }`}>
          {message.image_url && (
            <img src={message.image_url} alt="" className="rounded-card mb-2 max-h-48 w-full object-cover" />
          )}
          <p className="text-sm leading-relaxed">{message.message}</p>
        </div>
        <p className={`text-xs text-slate-300 dark:text-slate-600 mt-1 ${isOwn ? "text-right" : "text-left"} ml-1`}>
          {formatMessageTime(message.created_date || message.created_at)}
        </p>
      </div>
    </div>
  );
}

export default function Chat() {
  const { toast } = useToast();
  // useSearchParams e não window.location.search (seção 158): a leitura
  // direta não reage a um <Link> que só muda a query na mesma rota -- estando
  // no Chat, clicar em "Nova mensagem" de outra conversa (Notificações, sino)
  // trocava a URL mas deixava a conversa antiga aberta. Mesmo motivo do
  // SupplierProfile.jsx (CLAUDE.md).
  const [searchParams] = useSearchParams();
  const initConvId = searchParams.get("conversation_id");
  const initWithName = searchParams.get("with");
  const initSupplierId = searchParams.get("supplier_id");
  const initAdId = searchParams.get("ad_id");

  const { user: currentUser, authChecked } = useAuth();
  const location = useLocation();

  // Deslogado, a tela abria vazia ("Nenhuma conversa ainda") como se a
  // pessoa não tivesse mensagens. Pede login e volta para cá com a query --
  // quem veio do botão Chat de um anúncio cai de novo na conversa certa.
  useEffect(() => {
    if (authChecked && !currentUser) {
      api.auth.redirectToLogin(location.pathname + location.search);
    }
  }, [authChecked, currentUser, location.pathname, location.search]);
  const [activeConversationId, setActiveConversationId] = useState(initConvId || null);
  const [activeConvName, setActiveConvName] = useState(initWithName || "");
  const [activeReceiverId, setActiveReceiverId] = useState(initSupplierId || "");
  const [activeAdId, setActiveAdId] = useState(initAdId || null);
  const [message, setMessage] = useState("");
  const [sendingImage, setSendingImage] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageFile, setImageFile] = useState(null);
  const messagesEndRef = useRef(null);
  const queryClient = useQueryClient();

  // A URL manda na conversa aberta: sempre que os parâmetros mudam, a
  // conversa ativa acompanha. Sem conversation_id, gera o id a partir dos dois
  // emails (primeiro contato vindo do anúncio). Clicar numa conversa da lista
  // muda só o estado, não a URL -- então este efeito não roda e não desfaz o
  // clique. Depende do EMAIL, não do objeto do usuário: um refresh de sessão
  // troca o objeto e reabriria a conversa da URL por cima da escolhida.
  const currentEmail = currentUser?.email;
  useEffect(() => {
    const convId = initConvId
      || (initSupplierId && currentEmail ? [currentEmail, initSupplierId].sort().join("__") : null);
    if (!convId) return;
    setActiveConversationId(convId);
    setActiveConvName(initWithName || "");
    setActiveReceiverId(initSupplierId || "");
    setActiveAdId(initAdId || null);
  }, [initConvId, initWithName, initSupplierId, initAdId, currentEmail]);

  // Buscar mensagens da conversa ativa
  const { data: messages = [] } = useQuery({
    queryKey: ["chat-messages", activeConversationId],
    // As 100 MAIS NOVAS, em ordem de leitura. Pedia "created_date" (mais
    // antigas primeiro) com limite 100: numa conversa longa, as mensagens
    // novas simplesmente não apareciam.
    queryFn: async () =>
      activeConversationId
        ? (await api.entities.ChatMessage.filter({ conversation_id: activeConversationId }, "-created_date", 100)).reverse()
        : [],
    enabled: !!activeConversationId,
    refetchInterval: 3000,
  });

  // Buscar todas as conversas do usuário
  const { data: userMessages = [] } = useQuery({
    queryKey: ["user-messages", currentUser?.email],
    queryFn: () => api.entities.ChatMessage.listForCurrentUser("-created_date", 200),
    enabled: !!currentUser,
    refetchInterval: 5000,
  });

  // ABRIR A CONVERSA = LER (seção 156). Quando a conversa ativa tem mensagem
  // recebida e não lida, marca a conversa inteira como lida no banco e
  // atualiza os contadores (NavBar, lista de conversas, Notificações).
  //
  // Como a conversa é recarregada a cada 3s, mensagem que chega com ela
  // aberta é marcada no ciclo seguinte -- a pessoa está olhando. Com a aba em
  // segundo plano, NÃO marca: ela não viu.
  //
  // `marcarFalhou`: se chat-read-receipts.sql ainda não foi rodado, a RPC não
  // existe; sem essa trava o erro se repetiria a cada 3s.
  const marcarFalhou = useRef(false);
  useEffect(() => {
    if (!activeConversationId || marcarFalhou.current) return;
    const temNaoLida = messages.some(
      (m) => isReceivedChatMessage(m, currentUser) && m.read !== true
    );
    if (!temNaoLida || document.visibilityState !== "visible") return;
    api.chat.markConversationRead(activeConversationId)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["chat-unread"] });
        queryClient.invalidateQueries({ queryKey: ["user-messages"] });
        queryClient.invalidateQueries({ queryKey: ["notification-messages"] });
      })
      .catch(() => {
        marcarFalhou.current = true;
      });
  }, [messages, activeConversationId, currentUser, queryClient]);

  // Rola para o fim quando a conversa abre E quando chega mensagem. Antes só
  // rolava ao trocar de conversa -- as mensagens ainda nem tinham carregado, e
  // a conversa abria no topo.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversationId, messages.length]);

  // O anúncio da conversa vem da URL ou da lista -- e, se nenhum dos dois
  // trouxe (link das Notificações), das próprias mensagens. Sem ad_id, a
  // resposta do dono não saía como o anúncio (trigger route_chat_message) e
  // levava o e-mail de LOGIN dele ao cliente.
  const conversationAdId = activeAdId || messages.find((m) => m.ad_id)?.ad_id || null;

  // Quem está do outro lado: escrevendo PARA o anúncio, é o fornecedor; numa
  // conversa de anúncio em que o destino não é o anúncio, é o cliente. O
  // rótulo fixo "Fornecedor" aparecia também para o fornecedor falando com
  // um cliente.
  const otherRole = !conversationAdId ? "" : activeReceiverId === conversationAdId ? "Fornecedor" : "Cliente";
  const isFornecedor = currentUser?.role === "fornecedor" || currentUser?.role === "admin";

  // Consolidar conversas únicas
  const conversations = React.useMemo(() => {
    const map = {};
    userMessages.forEach((msg) => {
      const isOwnMessage = isOwnChatMessage(msg, currentUser);
      // Recebida e não lida: soma no número da conversa na lista.
      const naoLida = isReceivedChatMessage(msg, currentUser) && msg.read !== true ? 1 : 0;
      const otherId = isOwnMessage ? msg.receiver_id : msg.sender_id;
      const otherName = isOwnMessage ? (msg.receiver_name || msg.receiver_id) : msg.sender_name;
      if (!map[msg.conversation_id]) {
        map[msg.conversation_id] = {
          id: msg.conversation_id,
          with_id: otherId,
          with_name: otherName,
          last_message: msg.message,
          created_date: msg.created_date,
          ad_id: msg.ad_id || null,
          unread: naoLida,
        };
      } else {
        map[msg.conversation_id].unread += naoLida;
        if (!map[msg.conversation_id].ad_id && msg.ad_id) {
          map[msg.conversation_id].ad_id = msg.ad_id;
        }
      }
    });
    return Object.values(map);
  }, [userMessages, currentUser]);

  const sendMutation = useMutation({
    mutationFn: async ({ text, imgUrl }) => {
      return api.entities.ChatMessage.create({
        conversation_id: activeConversationId,
        // sender_id é regravado pelo banco (trigger route_chat_message): vale
        // o e-mail do login, ou o id do anúncio quando quem responde é o dono.
        sender_id: currentUser?.email || "anon",
        sender_name: currentUser?.full_name || "Usuário",
        receiver_id: activeReceiverId,
        receiver_name: activeConvName || activeReceiverId,
        message: text,
        image_url: imgUrl || "",
        ad_id: conversationAdId,
      });
    },
    onSuccess: (createdMessage) => {
      queryClient.setQueryData(
        ["chat-messages", activeConversationId],
        (currentMessages = []) => [...currentMessages, createdMessage]
      );
      queryClient.invalidateQueries({ queryKey: ["chat-messages", activeConversationId] });
      queryClient.invalidateQueries({ queryKey: ["user-messages"] });
    },
    onError: (error) => {
      toast({
        title: "Não foi possível enviar a mensagem",
        description: error.message || "Verifique sua sessão e tente novamente.",
        variant: "destructive",
      });
    },
  });

  const handleSend = async () => {
    // O Enter chamava isto mesmo com o botão desabilitado: dois Enter rápidos
    // mandavam a mensagem duas vezes.
    if (!message.trim() && !imageFile) return;
    if (sendMutation.isPending || sendingImage || !currentUser || !activeReceiverId) return;
    let imgUrl = "";
    if (imageFile) {
      // Falha no upload deixava o spinner girando para sempre, sem aviso.
      setSendingImage(true);
      try {
        const { file_url } = await api.integrations.Core.UploadFile({ file: imageFile });
        imgUrl = file_url;
      } catch (error) {
        toast({
          title: "Não foi possível enviar a imagem",
          description: error.message || "Tente novamente.",
          variant: "destructive",
        });
        return;
      } finally {
        setSendingImage(false);
      }
      setImagePreview(null);
      setImageFile(null);
    }
    try {
      await sendMutation.mutateAsync({ text: message.trim() || (imgUrl ? "Imagem" : ""), imgUrl });
      setMessage("");
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch {
      // O erro já é exibido pelo onError da mutation.
    }
  };

  const handleImageSelect = (e) => {
    const file = e.target.files[0];
    // Zera o input: escolher a MESMA imagem de novo não disparava onChange.
    e.target.value = "";
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <div className="max-w-6xl mx-auto w-full flex-1 flex flex-col px-4 py-6 gap-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link to={createPageUrl(isFornecedor ? "Dashboard" : "Suppliers")}>
            <Button variant="ghost" size="sm" className="rounded-card text-slate-500 dark:text-slate-400">
              <ArrowLeft className="w-4 h-4 mr-1" /> {isFornecedor ? "Dashboard" : "Fornecedores"}
            </Button>
          </Link>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">Mensagens</h1>
        </div>

        <div className="flex-1 grid md:grid-cols-[280px_1fr] gap-4 min-h-[600px]">
          {/* Sidebar - conversas */}
          {/* No celular a grade vira uma coluna: lista OU conversa, não as
              duas empilhadas (a conversa ficava abaixo da lista inteira). */}
          <div className={`${activeConversationId ? "hidden md:flex" : "flex"} bg-white dark:bg-slate-900 rounded-card border border-slate-100 dark:border-slate-800 shadow-sm p-4 flex-col gap-2 overflow-y-auto`}>
            <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-2 mb-2">Conversas</p>
            {conversations.length === 0 && (
              <div className="flex flex-col items-center justify-center flex-1 text-center py-10">
                <MessageSquare className="w-10 h-10 text-slate-200 dark:text-slate-700 mb-3" />
                <p className="text-slate-400 dark:text-slate-500 text-sm">Nenhuma conversa ainda</p>
                <p className="text-slate-300 dark:text-slate-600 text-xs mt-1">Inicie um contato pelo perfil de um fornecedor</p>
              </div>
            )}
            {conversations.map((conv) => (
              <ConversationItem
                key={conv.id}
                conv={conv}
                isActive={activeConversationId === conv.id}
                onClick={() => {
                  setActiveConversationId(conv.id);
                  setActiveConvName(conv.with_name);
                  setActiveReceiverId(conv.with_id);
                  setActiveAdId(conv.ad_id || null);
                }}
              />
            ))}
          </div>

          {/* Chat area */}
          <div className={`${activeConversationId ? "flex" : "hidden md:flex"} bg-white dark:bg-slate-900 rounded-card border border-slate-100 dark:border-slate-800 shadow-sm flex-col overflow-hidden`}>
            {!activeConversationId ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                <div className="w-16 h-16 rounded-card bg-slate-50 dark:bg-slate-800 flex items-center justify-center mb-4">
                  <MessageSquare className="w-8 h-8 text-slate-300 dark:text-slate-600" />
                </div>
                <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-1">Selecione uma conversa</h3>
                <p className="text-slate-400 dark:text-slate-500 text-sm">Ou inicie pelo perfil de um fornecedor</p>
              </div>
            ) : (
              <>
                {/* Chat header */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveConversationId(null)}
                    aria-label="Voltar às conversas"
                    className="md:hidden -ml-2 p-1.5 rounded-card text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="w-9 h-9 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-sm">
                    {activeConvName?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800 dark:text-slate-100 text-sm">{activeConvName || "Conversa"}</p>
                    {/* Sem presença ("online"): o produto não tem esse dado. */}
                    {otherRole && <p className="text-xs text-slate-400 dark:text-slate-500">{otherRole}</p>}
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1" style={{ minHeight: 0 }}>
                  <AnimatePresence>
                    {messages.map((msg) => (
                      <motion.div key={msg.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }}>
                        <MessageBubble message={msg} currentUser={currentUser} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                  <div ref={messagesEndRef} />
                </div>

                {/* Image preview */}
                {imagePreview && (
                  <div className="px-4 pb-2">
                    <div className="relative inline-block">
                      <img src={imagePreview} alt="" className="h-20 rounded-card object-cover" />
                      <button type="button" aria-label="Remover imagem" onClick={() => { setImagePreview(null); setImageFile(null); }} className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full p-0.5">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Input */}
                <div className="px-4 pb-4 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                  <label aria-label="Anexar imagem" className="cursor-pointer p-2.5 rounded-card hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 hover:text-orange-500 transition-colors">
                    {sendingImage ? <Loader2 className="w-5 h-5 animate-spin" /> : <ImagePlus className="w-5 h-5" />}
                    <input type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
                  </label>
                  <Input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
                    placeholder="Digite uma mensagem..."
                    aria-label="Mensagem"
                    className="flex-1 rounded-card border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 focus:bg-white dark:focus:bg-slate-900"
                  />
                  <Button
                    onClick={handleSend}
                    aria-label="Enviar"
                    disabled={sendMutation.isPending || !currentUser || !activeReceiverId || (!message.trim() && !imageFile)}
                    className="rounded-card bg-orange-500 px-4 hover:bg-orange-600"
                  >
                    {sendMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}