// Estado da cobrança na tela de Pagamento (§239), a partir da linha de
// `payments` que o próprio dono lê (RLS). Só EXIBE: quem ativa o plano é o
// webhook (billing_apply_gateway_payment), nunca o navegador.
//
//   waiting   -> aguardando o pagamento (continua consultando)
//   activated -> pago e aplicado: o plano já está ativo
//   review    -> pago, mas não aplicado (atrasado, já tinha plano...): suporte
//   closed    -> recusada/estornada/anulada: gerar outra
export function paymentProgress(row) {
  if (!row) return "waiting";
  if (row.status === "approved") return row.consumed_at ? "activated" : "review";
  if (row.status === "refused" || row.status === "refunded") return "closed";
  return "waiting";
}

export const PAYMENT_POLL_MS = 5000;
// Depois disso a tela para de consultar sozinha e oferece "Já paguei".
export const PAYMENT_POLL_MAX_MS = 15 * 60 * 1000;
