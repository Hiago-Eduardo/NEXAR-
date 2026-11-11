import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatCountdown,
  getSubscriptionState,
  hasCountdown,
  hasUsableBenefits,
  nextBillingDateEstimate,
} from "./subscription";

// Relógio fixo: 2026-11-10 12:00 (horário local). Todas as datas abaixo são
// relativas a ele, então o teste não depende do dia em que roda.
const AGORA = new Date(2026, 10, 10, 12, 0, 0);
const daqui = (ms) => new Date(AGORA.getTime() + ms).toISOString();
const HORA = 3600 * 1000;
const DIA = 24 * HORA;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AGORA);
});
afterEach(() => vi.useRealTimers());

describe("getSubscriptionState", () => {
  it("sem assinatura = 'none'", () => {
    expect(getSubscriptionState(null)).toBe("none");
    expect(getSubscriptionState(undefined)).toBe("none");
  });

  it("ativa e dentro do prazo = 'active'", () => {
    expect(getSubscriptionState({ status: "active", expires_at: daqui(DIA) })).toBe("active");
  });

  it("Básico (expires_at = 'infinity') continua ativo", () => {
    expect(getSubscriptionState({ status: "active", expires_at: "infinity" })).toBe("active");
  });

  it("cancelada mas ainda no período pago = 'cancelled_active'", () => {
    expect(getSubscriptionState({ status: "cancelled", expires_at: daqui(DIA) })).toBe("cancelled_active");
  });

  it("prazo vencido vira 'expired' mesmo com status 'active' (o banco ainda não sincronizou)", () => {
    expect(getSubscriptionState({ status: "active", expires_at: daqui(-1000) })).toBe("expired");
    expect(getSubscriptionState({ status: "cancelled", expires_at: daqui(-1000) })).toBe("expired");
  });

  it("vence exatamente agora = 'expired'", () => {
    expect(getSubscriptionState({ status: "active", expires_at: daqui(0) })).toBe("expired");
  });

  it("falha de pagamento = 'suspended', e tem prioridade sobre o prazo", () => {
    expect(getSubscriptionState({ status: "suspended", expires_at: daqui(-DIA) })).toBe("suspended");
  });

  it("status desconhecido é tratado como encerrado (nunca libera benefício por engano)", () => {
    expect(getSubscriptionState({ status: "qualquer", expires_at: daqui(DIA) })).toBe("expired");
  });
});

describe("hasUsableBenefits", () => {
  it("só 'active' e 'cancelled_active' dão acesso aos recursos do plano", () => {
    expect(hasUsableBenefits({ status: "active", expires_at: daqui(DIA) })).toBe(true);
    expect(hasUsableBenefits({ status: "cancelled", expires_at: daqui(DIA) })).toBe(true);
    expect(hasUsableBenefits({ status: "active", expires_at: daqui(-DIA) })).toBe(false);
    expect(hasUsableBenefits({ status: "suspended", expires_at: daqui(DIA) })).toBe(false);
    expect(hasUsableBenefits(null)).toBe(false);
  });
});

describe("hasCountdown", () => {
  it("plano com data de fim mostra contagem; Básico e sem data não", () => {
    expect(hasCountdown({ expires_at: daqui(DIA) })).toBe(true);
    expect(hasCountdown({ expires_at: "infinity" })).toBe(false);
    expect(hasCountdown({})).toBe(false);
    expect(hasCountdown(null)).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("sem data ou 'infinity' = null", () => {
    expect(formatCountdown(null)).toBeNull();
    expect(formatCountdown("infinity")).toBeNull();
  });

  it("prazo passado = 'Plano vencido'", () => {
    expect(formatCountdown(daqui(-1000))).toBe("Plano vencido");
  });

  it("dias e horas, com singular e plural", () => {
    expect(formatCountdown(daqui(2 * DIA + 3 * HORA))).toBe("2 dias, 3 horas restantes");
    expect(formatCountdown(daqui(1 * DIA + 1 * HORA))).toBe("1 dia, 1 hora restantes");
  });

  it("menos de um dia mostra horas e minutos; menos de uma hora, só minutos", () => {
    expect(formatCountdown(daqui(5 * HORA + 30 * 60 * 1000))).toBe("5 horas, 30 minutos restantes");
    expect(formatCountdown(daqui(1 * 60 * 1000))).toBe("1 minuto restantes");
  });

  // Bug encontrado escrevendo este teste: o cálculo convertia "1 mês e 14
  // dias" em 30 + 14 = 44 dias, mas 45 dias a partir de 1º de janeiro dão
  // 1 mês (31 dias) e 14 dias. Qualquer prazo acima de ~1 mês saía errado.
  it("prazos maiores que um mês contam os dias de verdade", () => {
    expect(formatCountdown(daqui(45 * DIA))).toBe("45 dias, 0 horas restantes");
    expect(formatCountdown(daqui(31 * DIA + 2 * HORA))).toBe("31 dias, 2 horas restantes");
    expect(formatCountdown(daqui(400 * DIA))).toBe("400 dias, 0 horas restantes");
  });
});

describe("nextBillingDateEstimate (cobrança no dia 10)", () => {
  it("antes do dia 10, cobra no dia 10 do mesmo mês", () => {
    expect(nextBillingDateEstimate(new Date(2026, 10, 3))).toEqual(new Date(2026, 10, 10));
  });

  it("no dia 10 ou depois, cobra no dia 10 do mês seguinte", () => {
    expect(nextBillingDateEstimate(new Date(2026, 10, 10))).toEqual(new Date(2026, 11, 10));
    expect(nextBillingDateEstimate(new Date(2026, 10, 25))).toEqual(new Date(2026, 11, 10));
  });

  it("virada de ano: dezembro depois do dia 10 vai para janeiro", () => {
    expect(nextBillingDateEstimate(new Date(2026, 11, 15))).toEqual(new Date(2027, 0, 10));
  });

  it("data inválida = null", () => {
    expect(nextBillingDateEstimate("não é data")).toBeNull();
  });
});
