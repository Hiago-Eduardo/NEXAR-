// Quem enviou / quem recebe uma mensagem do chat (seção 166).
//
// Desde supabase/chat-by-account.sql o endereço de verdade é a CONTA
// (sender_user_id / receiver_user_id). O e-mail em sender_id/receiver_id
// deixou de servir para isso: numa conversa de anúncio, a mensagem do dono
// sai com sender_id = id do anúncio, e a do cliente com receiver_id = id do
// anúncio. Comparar por e-mail classificaria a resposta do próprio dono como
// "recebida".
//
// Mensagens antigas (antes do acerto do SQL) podem não ter as colunas de
// conta -- aí vale o e-mail, como antes.

const mesmoEmail = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function isOwnChatMessage(message, user) {
  if (!message || !user) return false;
  if (message.sender_user_id) return message.sender_user_id === user.id;
  return mesmoEmail(message.sender_id, user.email);
}

export function isReceivedChatMessage(message, user) {
  if (!message || !user) return false;
  if (message.receiver_user_id) return message.receiver_user_id === user.id;
  return mesmoEmail(message.receiver_id, user.email);
}
