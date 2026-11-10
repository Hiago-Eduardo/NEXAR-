import { describe, it, expect } from "vitest";
import {
  classifyPlanChange,
  chargesNow,
  takesEffectNow,
  PLAN_AD_LIMITS,
  PLAN_RANKS,
  PLAN_PRICES,
  formatBRL,
  isPlanPurchasable,
  describePlanChangeError,
  PAID_CHECKOUT_AVAILABLE,
  PAID_PLAN_UNAVAILABLE_MESSAGE,
  checkoutFeedback,
} from "./plans";
import { CHECKOUT_ERROR_CODES } from "../../../Backend/supabase/functions/_shared/asaas.js";
import { nextBillingDateEstimate, BILLING_DAY } from "./subscription";

/**
 * POR QUE ESTES TESTES EXISTEM
 *
 * `classifyPlanChange` é o espelho, na interface, do que
 * supabase/billing-cycle-day-10.sql faz no banco. Se os dois discordarem, a
 * tela PROMETE uma coisa e o banco FAZ outra -- e o pior é que nada quebra
 * visivelmente: o fornecedor lê "vale agora", confirma, e o banco agenda para
 * o dia 10. Foi exatamente o risco levantado na seção 109 e o motivo de esta
 * matriz existir.
 *
 * A tabela abaixo é a regra escrita uma vez só. Cada linha corresponde a um
 * ramo de `subscribe_to_plan`:
 *
 *   v_current.id is null                         -> 'new'
 *   v_current.plan_id = p_plan_id                -> 'same'       (ALREADY_ON_PLAN)
 *   plan_rank(novo) > plan_rank(atual)           -> 'upgrade'    (imediato)
 *   resto                                        -> 'downgrade'  (dia 10)
 */
const MATRIZ = [
  // [plano atual, plano escolhido, classificação esperada, por quê]
  [null,           "basico",       "new",       "sem plano -> Básico entra na hora"],
  [null,           "profissional", "new",       "sem plano -> pago entra na hora, ciclo parcial"],
  [null,           "premium",      "new",       "sem plano -> pago entra na hora, ciclo parcial"],

  ["basico",       "profissional", "upgrade",   "rank 0 -> 1: sobe, e por isso vale agora"],
  ["basico",       "premium",      "upgrade",   "rank 0 -> 2"],
  ["profissional", "premium",      "upgrade",   "rank 1 -> 2: recebe o que contratou na hora"],

  ["premium",      "profissional", "downgrade", "rank 2 -> 1: só no dia 10, sem perder o pago"],
  ["premium",      "basico",       "downgrade", "rank 2 -> 0"],
  ["profissional", "basico",       "downgrade", "rank 1 -> 0"],

  ["basico",       "basico",       "same",      "mesmo plano"],
  ["profissional", "profissional", "same",      "mesmo plano"],
  ["premium",      "premium",      "same",      "mesmo plano"],
];

describe("classifyPlanChange -- espelho de subscribe_to_plan", () => {
  for (const [atual, escolhido, esperado, porque] of MATRIZ) {
    it(`${atual ?? "sem plano"} -> ${escolhido}: ${esperado} (${porque})`, () => {
      expect(classifyPlanChange(atual, escolhido)).toBe(esperado);
    });
  }

  it("a direção é decidida por rank, não por uma lista de casos", () => {
    // Se alguém voltar a tratar o Básico com um `if` próprio, este teste
    // continua passando -- mas se inverter a comparação de rank, ele quebra.
    for (const [atual, escolhido, esperado] of MATRIZ) {
      if (esperado !== "upgrade" && esperado !== "downgrade") continue;
      const subiu = PLAN_RANKS[escolhido] > PLAN_RANKS[atual];
      expect(classifyPlanChange(atual, escolhido)).toBe(subiu ? "upgrade" : "downgrade");
    }
  });

  it("o Básico não é mais exceção: sair dele é upgrade como qualquer outro", () => {
    // Até a seção 120 havia um `if (currentPlanId === "basico") return "immediate"`.
    // Agora isso tem que sair da hierarquia sozinho.
    expect(classifyPlanChange("basico", "profissional")).toBe("upgrade");
    expect(PLAN_RANKS.basico).toBeLessThan(PLAN_RANKS.profissional);
  });

  it("não devolve mais o vocabulário intermediário immediate/deferred", () => {
    const saidas = new Set(MATRIZ.map(([a, e]) => classifyPlanChange(a, e)));
    expect([...saidas].sort()).toEqual(["downgrade", "new", "same", "upgrade"]);
  });
});

describe("takesEffectNow -- quem recebe o plano na hora", () => {
  it("assinatura nova e upgrade valem imediatamente", () => {
    expect(takesEffectNow(classifyPlanChange(null, "premium"))).toBe(true);
    expect(takesEffectNow(classifyPlanChange("profissional", "premium"))).toBe(true);
    expect(takesEffectNow(classifyPlanChange("basico", "premium"))).toBe(true);
  });

  it("downgrade NÃO vale imediatamente -- espera o dia 10", () => {
    // A outra metade da regra: não retirar recursos antes da data (spec §7).
    expect(takesEffectNow(classifyPlanChange("premium", "profissional"))).toBe(false);
    expect(takesEffectNow(classifyPlanChange("premium", "basico"))).toBe(false);
  });
});

describe("chargesNow -- nada cobra no ato", () => {
  // A data oficial de cobrança é o dia 10 (spec §4). Nem a primeira
  // assinatura (§5) nem o upgrade (§6) cobram na hora. Este bloco existe para
  // que reintroduzir cobrança imediata seja uma decisão consciente, com um
  // teste vermelho na frente, e não um efeito colateral.
  it("nenhuma troca cobra agora", () => {
    for (const [atual, escolhido] of MATRIZ) {
      expect(chargesNow(classifyPlanChange(atual, escolhido), PLAN_PRICES[escolhido])).toBe(false);
    }
  });
});

describe("nextBillingDateEstimate -- o dia 10 na interface", () => {
  // Espelho de next_billing_date() no banco. SÓ PARA EXIBIÇÃO: quem grava a
  // data de verdade é o Postgres, em next_charge_at.
  it("antes do dia 10, cai no dia 10 do mesmo mês", () => {
    const d = nextBillingDateEstimate(new Date(2026, 8, 3)); // 03/09/2026
    expect(d.getDate()).toBe(10);
    expect(d.getMonth()).toBe(8);
  });

  it("depois do dia 10, cai no dia 10 do mês seguinte", () => {
    const d = nextBillingDateEstimate(new Date(2026, 8, 21)); // 21/09/2026
    expect(d.getDate()).toBe(10);
    expect(d.getMonth()).toBe(9);
  });

  it("NO dia 10 já aponta para o mês seguinte", () => {
    // A cobrança do próprio dia 10 é a que está acontecendo agora -- a
    // "próxima" é a de daqui a um mês. Mesma regra do `<` no SQL.
    const d = nextBillingDateEstimate(new Date(2026, 8, 10));
    expect(d.getDate()).toBe(10);
    expect(d.getMonth()).toBe(9);
  });

  it("vira o ano em dezembro", () => {
    const d = nextBillingDateEstimate(new Date(2026, 11, 25)); // 25/12/2026
    expect(d.getDate()).toBe(10);
    expect(d.getMonth()).toBe(0);
    expect(d.getFullYear()).toBe(2027);
  });

  it("sempre cai no dia oficial, em qualquer dia do ano", () => {
    for (let mes = 0; mes < 12; mes += 1) {
      for (const dia of [1, 9, 10, 11, 28]) {
        const d = nextBillingDateEstimate(new Date(2026, mes, dia));
        expect(d.getDate()).toBe(BILLING_DAY);
      }
    }
  });
});

describe("limites, hierarquia e preços continuam espelhando o banco", () => {
  // plan_ad_limit() em supabase/rls-policies.sql. O 2147483647 de lá é o
  // Infinity daqui -- é int4 max porque a coluna é integer.
  it("PLAN_AD_LIMITS bate com plan_ad_limit()", () => {
    expect(PLAN_AD_LIMITS).toEqual({ basico: 1, profissional: 5, premium: Infinity });
  });

  // plan_rank() em supabase/subscription-plan-change.sql. É a hierarquia que
  // decide upgrade vs downgrade, dos dois lados.
  it("PLAN_RANKS bate com plan_rank()", () => {
    expect(PLAN_RANKS).toEqual({ basico: 0, profissional: 1, premium: 2 });
  });

  it("o Básico é o único gratuito", () => {
    // subscribe_to_plan decide expires_at='infinity' e next_charge_at=null
    // por `p_plan_id <> 'basico'`. Se outro plano virar grátis, os dois lados
    // precisam mudar juntos.
    expect(PLAN_PRICES.basico).toBe(0);
    expect(PLAN_PRICES.profissional).toBeGreaterThan(0);
    expect(PLAN_PRICES.premium).toBeGreaterThan(0);
  });
});

describe("formatBRL -- preço no formato brasileiro", () => {
  // A tela do anúncio chegava a mostrar os dois formatos lado a lado:
  // "R$ 350.00" no card do produto (toFixed) e "R$ 350,00" no pedido mínimo
  // (texto digitado). Seção 146.
  it("usa vírgula decimal", () => {
    expect(formatBRL(350)).toContain("350,00");
  });

  it("usa ponto como separador de milhar", () => {
    expect(formatBRL(1890)).toContain("1.890,00");
  });

  it("sempre mostra dois decimais", () => {
    expect(formatBRL(12.5)).toContain("12,50");
  });

  it("devolve null para vazio, em vez de 'R$ NaN'", () => {
    // Quem exibe precisa poder colapsar o bloco; imprimir NaN seria pior que
    // não mostrar preço nenhum.
    for (const v of [null, undefined, "", "abc"]) {
      expect(formatBRL(v)).toBe(null);
    }
  });

  it("aceita número em string, que é como o banco às vezes devolve numeric", () => {
    expect(formatBRL("89.9")).toContain("89,90");
  });
});

describe("C1 -- plano pago não é contratável pela tela (Resumo.md §231)", () => {
  // O banco recusa com PAYMENT_REQUIRED (fix-paid-plan-activation.sql). Isto
  // só garante que a tela não ofereça o que o banco não conclui. Ligar
  // PAID_CHECKOUT_AVAILABLE tem de ser uma decisão consciente, junto com o
  // gateway -- este teste fica vermelho na frente.
  it("só o Básico é contratável enquanto não há pagamento online", () => {
    expect(PAID_CHECKOUT_AVAILABLE).toBe(false);
    expect(isPlanPurchasable("basico")).toBe(true);
    expect(isPlanPurchasable("profissional")).toBe(false);
    expect(isPlanPurchasable("premium")).toBe(false);
  });

  it("com o checkout desligado (testes/produção), nem do Básico nem sem plano o pago é contratável", () => {
    for (const atual of [null, "basico", "profissional", "premium"]) {
      expect(isPlanPurchasable("premium", atual)).toBe(false);
      expect(isPlanPurchasable("profissional", atual)).toBe(false);
      expect(isPlanPurchasable("basico", atual)).toBe(true);
    }
  });

  it("plano desconhecido ou adulterado nunca é contratável", () => {
    for (const p of [null, undefined, "", "Premium", " premium", "ouro", "essencial", "constructor", "__proto__", 0]) {
      expect(isPlanPurchasable(p)).toBe(false);
    }
  });

  it("PAYMENT_REQUIRED vira mensagem clara, sem prometer ativação", () => {
    const msg = describePlanChangeError({ message: "PAYMENT_REQUIRED" });
    expect(msg).toBe(PAID_PLAN_UNAVAILABLE_MESSAGE);
    expect(msg).toMatch(/Nenhum valor foi cobrado/);
    expect(msg).not.toMatch(/ativ(o|ado)/i);
    expect(describePlanChangeError({ message: "ALREADY_ON_PLAN" })).toMatch(/já é o seu plano/);
    expect(describePlanChangeError(null)).toMatch(/Tente novamente/);
  });
});

describe("checkout Asaas -- o que a tela mostra (§234)", () => {
  const codigo = /[A-Z]{2,}_[A-Z_]+|(sql|rpc|null|undefined|error|http)/i;
  it("todo código que a Edge Function devolve tem texto próprio, sem código interno", () => {
    const genericos = new Set(["INVALID_PLAN", "ACCOUNT_NOT_FOUND"]);
    for (const c of CHECKOUT_ERROR_CODES) {
      const fb = checkoutFeedback(c, 409);
      expect(fb.title).toBeTruthy();
      expect(fb.description).not.toMatch(codigo);
      if (!genericos.has(c)) expect(fb.title, c).not.toBe("Não foi possível gerar a cobrança");
    }
  });
  it("situações esperadas são aviso (não erro); só a indisponibilidade é erro", () => {
    for (const c of ["CHARGE_IN_PROGRESS", "PREVIOUS_CHARGE_IN_ANALYSIS", "PREVIOUS_CHARGE_PAID", "PAYMENT_UNDER_REVIEW",
                     "PREVIOUS_CHARGE_UNAPPLIED", "PREVIOUS_CHARGE_UNCONFIRMED", "PENDING_CHARGE_EXISTS"]) {
      expect(checkoutFeedback(c).tone, c).toBe("info");
    }
    expect(checkoutFeedback("gateway_unavailable").tone).toBe("error");
    expect(checkoutFeedback(null, 502).title).toMatch(/temporariamente indisponível/);
    expect(checkoutFeedback(null, 0).title).toMatch(/temporariamente indisponível/);
  });
  it("pagamento identificado recarrega a assinatura; código desconhecido vira texto genérico", () => {
    expect(checkoutFeedback("PREVIOUS_CHARGE_PAID").reload).toBe(true);
    const fb = checkoutFeedback("SQLSTATE_42501_QUALQUER", 500);
    expect(fb.description).toBe("Tente de novo em alguns instantes.");
    expect(checkoutFeedback("constructor").title).toBe("Não foi possível gerar a cobrança");
  });
});
