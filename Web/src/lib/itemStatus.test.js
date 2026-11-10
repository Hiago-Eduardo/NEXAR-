import { describe, it, expect } from "vitest";
import {
  getItemState, countItemStates, describeSuspension, planRuleErrorMessage, isSystemSuspended,
} from "./itemStatus";

describe("getItemState", () => {
  it("separa os quatro estados", () => {
    expect(getItemState({ status: "active" })).toBe("active");
    expect(getItemState({ status: "paused" })).toBe("paused");
    expect(getItemState({ status: "suspended", suspension_reason: "plan_limit" })).toBe("suspended_plan_limit");
    expect(getItemState({ status: "suspended", suspension_reason: "no_plan" })).toBe("suspended_no_plan");
  });

  it("status ausente é ativo (linhas antigas de suppliers)", () => {
    expect(getItemState({})).toBe("active");
    expect(getItemState({ status: null })).toBe("active");
  });

  it("suspenso sem motivo é falta de plano (suspensões anteriores à coluna)", () => {
    expect(getItemState({ status: "suspended", suspension_reason: null })).toBe("suspended_no_plan");
  });

  it("pausado NÃO é suspensão do sistema", () => {
    expect(isSystemSuspended({ status: "paused" })).toBe(false);
    expect(isSystemSuspended({ status: "suspended" })).toBe(true);
  });
});

describe("countItemStates", () => {
  it("conta cada estado separadamente", () => {
    expect(countItemStates([
      { status: "active" }, { status: "active" }, { status: "paused" },
      { status: "suspended", suspension_reason: "plan_limit" },
      { status: "suspended", suspension_reason: "no_plan" },
    ])).toEqual({ active: 2, paused: 1, suspended_plan_limit: 1, suspended_no_plan: 1 });
  });
});

describe("describeSuspension", () => {
  it("plan_limit fala em mudar de plano, no_plan em assinar", () => {
    expect(describeSuspension({ status: "suspended", suspension_reason: "plan_limit" }, "anúncio").description)
      .toMatch(/plano maior/);
    expect(describeSuspension({ status: "suspended", suspension_reason: "no_plan" }, "produto").description)
      .toMatch(/Assine um plano/);
  });
});

describe("planRuleErrorMessage", () => {
  it("traduz as mensagens do banco", () => {
    expect(planRuleErrorMessage("AD_SUSPENDED: anuncio suspenso pelo sistema", "anúncio")).toMatch(/volta sozinho/);
    expect(planRuleErrorMessage("SWAP_NOT_PLAN_LIMIT: so um item suspenso", "anúncio")).toMatch(/no lugar de outro/);
    expect(planRuleErrorMessage("SWAP_NOT_ACTIVE: o item que sai", "produto")).toMatch(/não está mais ativo/);
    expect(planRuleErrorMessage("PRODUCT_SUSPENDED: produto suspenso", "produto")).toMatch(/volta sozinho/);
    expect(planRuleErrorMessage("PLAN_LIMIT: voce atingiu o limite de produtos ativos do seu plano.", "produto"))
      .toMatch(/máximo de produtos ativos/);
    expect(planRuleErrorMessage("PLAN_LIMIT: voce atingiu o limite de anuncios do seu plano.", "anúncio"))
      .toMatch(/limite de anúncios/);
    expect(planRuleErrorMessage("PLAN_REQUIRED: voce precisa de um plano", "produto")).toMatch(/plano ativo/);
  });

  it("devolve null para erro que não é regra de plano", () => {
    expect(planRuleErrorMessage("network error", "produto")).toBeNull();
    expect(planRuleErrorMessage(undefined, "produto")).toBeNull();
  });
});
