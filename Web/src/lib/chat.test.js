import { describe, it, expect } from "vitest";
import { isOwnChatMessage, isReceivedChatMessage } from "./chat";

const dono = { id: "u-dono", email: "login@fornecedor.com" };
const cliente = { id: "u-cliente", email: "Cliente@Exemplo.com" };
const anuncio = "ad-123";

describe("mensagens por conta (conversa de anúncio)", () => {
  // Cliente escreve para o anúncio: receiver_id é o id do ANÚNCIO, não um e-mail.
  const doCliente = { sender_id: "cliente@exemplo.com", sender_user_id: "u-cliente", receiver_id: anuncio, receiver_user_id: "u-dono" };
  // Dono responde: sender_id é o id do ANÚNCIO, nunca o e-mail de login.
  const doDono = { sender_id: anuncio, sender_user_id: "u-dono", receiver_id: "cliente@exemplo.com", receiver_user_id: "u-cliente" };

  it("a resposta do dono é DELE, mesmo com sender_id sendo o anúncio", () => {
    expect(isOwnChatMessage(doDono, dono)).toBe(true);
    expect(isReceivedChatMessage(doDono, dono)).toBe(false);
  });

  it("o dono recebe a mensagem do cliente, qualquer que seja o e-mail de contato", () => {
    expect(isReceivedChatMessage(doCliente, dono)).toBe(true);
    expect(isOwnChatMessage(doCliente, dono)).toBe(false);
  });

  it("do lado do cliente, o inverso", () => {
    expect(isOwnChatMessage(doCliente, cliente)).toBe(true);
    expect(isReceivedChatMessage(doDono, cliente)).toBe(true);
  });

  it("um terceiro não é dono nem destinatário", () => {
    const outro = { id: "u-outro", email: "outro@x.com" };
    expect(isOwnChatMessage(doCliente, outro)).toBe(false);
    expect(isReceivedChatMessage(doCliente, outro)).toBe(false);
  });
});

describe("mensagens antigas, só com e-mail", () => {
  const antiga = { sender_id: "login@fornecedor.com", receiver_id: "cliente@exemplo.com" };

  it("usa o e-mail, sem diferenciar maiúsculas", () => {
    expect(isOwnChatMessage(antiga, dono)).toBe(true);
    expect(isReceivedChatMessage(antiga, cliente)).toBe(true);
  });

  it("sem usuário ou sem mensagem, nunca é minha", () => {
    expect(isOwnChatMessage(antiga, null)).toBe(false);
    expect(isReceivedChatMessage(null, dono)).toBe(false);
  });
});
