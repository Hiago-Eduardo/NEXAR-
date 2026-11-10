import { describe, it, expect } from "vitest";
import { paymentProgress } from "./paymentStatus";

describe("paymentProgress", () => {
  it("sem linha ou pendente: aguardando", () => {
    expect(paymentProgress(null)).toBe("waiting");
    expect(paymentProgress({ status: "pending" })).toBe("waiting");
  });
  it("aprovado e consumido: plano ativo", () => {
    expect(paymentProgress({ status: "approved", consumed_at: "2026-11-09T12:00:00Z" })).toBe("activated");
  });
  it("aprovado sem consumo: em análise, nunca ativo", () => {
    expect(paymentProgress({ status: "approved", consumed_at: null, unapplied_reason: "LATE_PAYMENT" })).toBe("review");
  });
  it("recusado/estornado: encerrada", () => {
    expect(paymentProgress({ status: "refused" })).toBe("closed");
    expect(paymentProgress({ status: "refunded", consumed_at: "x" })).toBe("closed");
  });
});
