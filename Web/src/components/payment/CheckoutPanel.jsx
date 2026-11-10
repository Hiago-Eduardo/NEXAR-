import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Copy, CreditCard, Loader2, Lock, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { api } from "@/api/client";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { PLAN_LABELS, formatBRL, checkoutFeedback } from "@/lib/plans";
import { paymentProgress, PAYMENT_POLL_MS, PAYMENT_POLL_MAX_MS } from "@/lib/paymentStatus";

// Tela de cobrança do NEXAR (§240), no modelo das assinaturas tipo Spotify:
// resumo do plano de um lado, escolha da forma de pagamento do outro -- só
// Pix ou cartão de crédito, tudo dentro do NEXAR. O cartão vai do navegador
// para a Edge Function e dela para o Asaas; não é guardado em lugar nenhum
// (nem neste componente depois do envio). Nada é ativado pelo navegador: o
// status vem de `payments`, que só o servidor muda.

const digits = (v) => String(v ?? "").replace(/\D/g, "");
const groupCard = (v) => digits(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, "$1 ");
const maskExpiry = (v) => {
  const d = digits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};
const formatDue = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : null);

function MethodOption({ value, selected, onSelect, icon: Icon, title, subtitle, disabled, children }) {
  return (
    <div className={cn(
      "rounded-card border transition-colors",
      selected ? "border-orange-500 bg-white shadow-sm dark:bg-slate-900" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
      disabled && "opacity-50",
    )}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={() => onSelect(value)}
        className="flex w-full items-center gap-4 p-4 text-left"
      >
        <span className={cn(
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2",
          selected ? "border-orange-500" : "border-slate-300 dark:border-slate-600",
        )}>
          {selected && <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />}
        </span>
        <Icon className="h-5 w-5 shrink-0 text-slate-700 dark:text-slate-200" />
        <span className="min-w-0">
          <span className="block font-semibold text-slate-900 dark:text-slate-50">{title}</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">{subtitle}</span>
        </span>
      </button>
      {selected && <div className="border-t border-slate-100 p-4 dark:border-slate-800">{children}</div>}
    </div>
  );
}

function PixBox({ pix }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pix.copyPaste);
      toast({ title: "Código Pix copiado", description: "Cole no app do seu banco para pagar." });
    } catch {
      toast({ title: "Não foi possível copiar", description: "Selecione o código e copie manualmente." });
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
        <img src={pix.qrImage} alt="QR Code do Pix" width={176} height={176}
          className="h-44 w-44 rounded-card border border-slate-200 bg-white p-2 dark:border-slate-700" />
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Abra o app do seu banco e escolha pagar com Pix.</li>
          <li>Leia o QR Code ou cole o código copia e cola.</li>
          <li>Confirme. Esta tela atualiza sozinha quando o pagamento cair.</li>
        </ol>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={pix.copyPaste} onFocus={(e) => e.target.select()} aria-label="Pix copia e cola"
          className="min-w-0 flex-1 font-mono text-xs" />
        <Button type="button" onClick={copy} className="shrink-0 gap-1.5 rounded-card bg-orange-500 text-white hover:bg-orange-600">
          <Copy className="h-4 w-4" /> Copiar código
        </Button>
      </div>
    </div>
  );
}

const EMPTY_CARD = { number: "", holderName: "", expiry: "", ccv: "", cpfCnpj: "", postalCode: "", addressNumber: "", phone: "" };

function CardForm({ planId, amountLabel, onPaid }) {
  const { toast } = useToast();
  const [f, setF] = useState(EMPTY_CARD);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, fmt = (v) => v) => (e) => setF((o) => ({ ...o, [k]: fmt(e.target.value) }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setSending(true);
    const [mm, yy] = f.expiry.split("/");
    try {
      const res = await api.billing.payWithCard(
        planId,
        { number: f.number, holderName: f.holderName, expiryMonth: mm, expiryYear: yy, ccv: f.ccv },
        { name: f.holderName, cpfCnpj: f.cpfCnpj, postalCode: f.postalCode, addressNumber: f.addressNumber, phone: f.phone },
      );
      // Não fica nada do cartão na tela depois do envio.
      setF((o) => ({ ...o, number: "", ccv: "", expiry: "" }));
      if (res?.result === "activated" || res?.result === "already_applied") {
        onPaid();
      } else {
        toast({ title: "Pagamento em processamento", description: "Assim que a operadora confirmar, seu plano é ativado." });
        onPaid();
      }
    } catch (err) {
      setF((o) => ({ ...o, ccv: "" }));
      setError(checkoutFeedback(err?.checkoutCode, err?.httpStatus));
    } finally {
      setSending(false);
    }
  };

  const field = "space-y-1.5";
  return (
    <form onSubmit={submit} className="space-y-4" autoComplete="on">
      <div className={field}>
        <Label htmlFor="cc-number">Número do cartão</Label>
        <Input id="cc-number" inputMode="numeric" autoComplete="cc-number" placeholder="0000 0000 0000 0000"
          value={f.number} onChange={set("number", groupCard)} required />
      </div>
      <div className={field}>
        <Label htmlFor="cc-name">Nome impresso no cartão</Label>
        <Input id="cc-name" autoComplete="cc-name" placeholder="Como está no cartão"
          value={f.holderName} onChange={set("holderName", (v) => v.toUpperCase())} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label htmlFor="cc-exp">Validade</Label>
          <Input id="cc-exp" inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA"
            value={f.expiry} onChange={set("expiry", maskExpiry)} required />
        </div>
        <div className={field}>
          <Label htmlFor="cc-csc">CVV</Label>
          <Input id="cc-csc" inputMode="numeric" autoComplete="cc-csc" placeholder="123" type="password"
            value={f.ccv} onChange={set("ccv", (v) => digits(v).slice(0, 4))} required />
        </div>
      </div>

      <p className="pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Dados do titular</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor="h-doc">CPF ou CNPJ</Label>
          <Input id="h-doc" inputMode="numeric" value={f.cpfCnpj} onChange={set("cpfCnpj", (v) => digits(v).slice(0, 14))} required />
        </div>
        <div className={field}>
          <Label htmlFor="h-phone">Telefone</Label>
          <Input id="h-phone" inputMode="tel" autoComplete="tel" placeholder="DDD + número"
            value={f.phone} onChange={set("phone", (v) => digits(v).slice(0, 11))} required />
        </div>
        <div className={field}>
          <Label htmlFor="h-cep">CEP</Label>
          <Input id="h-cep" inputMode="numeric" autoComplete="postal-code"
            value={f.postalCode} onChange={set("postalCode", (v) => digits(v).slice(0, 8))} required />
        </div>
        <div className={field}>
          <Label htmlFor="h-num">Número do endereço</Label>
          <Input id="h-num" value={f.addressNumber} onChange={set("addressNumber", (v) => v.slice(0, 10))} required />
        </div>
      </div>

      {error && (
        <div role="alert" className="flex gap-2 rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span><strong>{error.title}.</strong> {error.description}</span>
        </div>
      )}

      <Button type="submit" disabled={sending}
        className="h-12 w-full gap-2 rounded-card bg-orange-500 text-base font-semibold text-white hover:bg-orange-600">
        {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> Processando…</> : <><Lock className="h-4 w-4" /> Pagar {amountLabel}</>}
      </Button>
      <p className="text-center text-xs text-slate-500 dark:text-slate-400">
        Ambiente de teste: use um cartão de teste (ex.: 5162 3062 1937 8829, validade 05/30, CVV 318). Nenhum valor real é cobrado.
      </p>
    </form>
  );
}

export default function CheckoutPanel({ planId }) {
  const queryClient = useQueryClient();
  const startedAt = useRef(Date.now());
  const [pollingOn, setPollingOn] = useState(true);
  const [method, setMethod] = useState("pix");

  // Uma chamada por plano: o react-query junta chamadas simultâneas, e
  // repetir depois só reaproveita a mesma cobrança no servidor.
  const checkout = useQuery({
    queryKey: ["billing-checkout", planId],
    queryFn: () => api.billing.startCheckout(planId),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const paymentId = checkout.data?.paymentId;

  const status = useQuery({
    queryKey: ["billing-payment-status", paymentId],
    queryFn: () => api.billing.getPaymentStatus(paymentId),
    enabled: !!paymentId,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (paymentProgress(q.state.data) !== "waiting") return false;
      if (Date.now() - startedAt.current > PAYMENT_POLL_MAX_MS) {
        setTimeout(() => setPollingOn(false), 0);
        return false;
      }
      return pollingOn ? PAYMENT_POLL_MS : false;
    },
  });
  const progress = paymentProgress(status.data);
  const planName = PLAN_LABELS[planId] || planId;

  useEffect(() => {
    if (progress !== "activated") return;
    queryClient.invalidateQueries({ queryKey: ["pagamento-subscription"] });
    queryClient.invalidateQueries({ queryKey: ["pagamento-history"] });
    queryClient.invalidateQueries({ queryKey: ["my-subscription"] });
  }, [progress, queryClient]);

  const shell = (content) => (
    <section aria-label="Pagamento" className="rounded-card border border-slate-200 bg-slate-50 p-5 sm:p-7 dark:border-slate-800 dark:bg-slate-900/60">
      {content}
    </section>
  );

  if (checkout.isLoading) {
    return shell(
      <div className="flex items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparando o pagamento do plano {planName}…
      </div>,
    );
  }

  if (checkout.isError) {
    const fb = checkoutFeedback(checkout.error?.checkoutCode, checkout.error?.httpStatus);
    return shell(
      <div className="space-y-4">
        <div className="flex gap-3">
          <AlertCircle className={cn("mt-0.5 h-5 w-5 shrink-0", fb.tone === "error" ? "text-red-500" : "text-orange-500")} />
          <div className="space-y-1 text-sm">
            <p className="font-semibold text-slate-900 dark:text-slate-50">{fb.title}</p>
            <p className="text-slate-600 dark:text-slate-300">{fb.description}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="rounded-card" onClick={() => checkout.refetch()}>Tentar de novo</Button>
          <Link to={`${createPageUrl("Planos")}?manage=1`}><Button variant="ghost" className="rounded-card">Voltar aos planos</Button></Link>
        </div>
      </div>,
    );
  }

  if (progress === "activated") {
    return shell(
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        <p className="font-display text-2xl font-extrabold text-slate-900 dark:text-slate-50">Pagamento confirmado</p>
        <p className="text-sm text-slate-600 dark:text-slate-300">Bem-vindo ao {planName}. Seu plano já está ativo.</p>
        <Link to={createPageUrl("Dashboard")}>
          <Button className="mt-2 h-11 rounded-card bg-orange-500 px-6 text-white hover:bg-orange-600">Ir para o painel</Button>
        </Link>
      </div>,
    );
  }

  if (progress === "review" || progress === "closed") {
    return shell(
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-orange-500" />
        <div className="space-y-1 text-sm">
          <p className="font-semibold text-slate-900 dark:text-slate-50">
            {progress === "review" ? "Pagamento recebido, em análise" : "Esta cobrança foi encerrada"}
          </p>
          <p className="text-slate-600 dark:text-slate-300">
            {progress === "review"
              ? "Recebemos o pagamento, mas ele precisa de uma conferência antes de ativar o plano. Nossa equipe vai entrar em contato."
              : "Ela não pode mais ser paga. Volte aos planos para gerar uma nova."}
          </p>
        </div>
      </div>,
    );
  }

  const { amountCents, dueDate, pix } = checkout.data;
  const chosen = !pix && method === "pix" ? "card" : method;
  const amountLabel = amountCents != null ? formatBRL(amountCents / 100) : "";

  return shell(
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div>
          <h2 className="font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">Forma de pagamento</h2>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            <Lock className="h-3.5 w-3.5" /> Pagamento seguro, feito aqui mesmo no NEXAR.
          </p>
        </div>
        <div role="radiogroup" aria-label="Forma de pagamento" className="space-y-3">
          <MethodOption value="pix" selected={chosen === "pix"} onSelect={setMethod} icon={QrCode}
            title="Pix" subtitle={pix ? "Aprovação na hora" : "Indisponível no momento"} disabled={!pix}>
            {pix && <PixBox pix={pix} />}
          </MethodOption>
          <MethodOption value="card" selected={chosen === "card"} onSelect={setMethod} icon={CreditCard}
            title="Cartão de crédito" subtitle="Visa, Mastercard, Elo, Amex e outros">
            <CardForm planId={planId} amountLabel={amountLabel} onPaid={() => status.refetch()} />
          </MethodOption>
        </div>
        {chosen === "pix" && pix && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-slate-500 dark:text-slate-400">
            {pollingOn ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Aguardando o pagamento…</>
            ) : (
              <>
                <span>Ainda não recebemos a confirmação.</span>
                <Button variant="outline" size="sm" className="rounded-card" onClick={() => {
                  startedAt.current = Date.now(); setPollingOn(true); status.refetch();
                }}>Já paguei — verificar</Button>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="h-fit rounded-card border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 lg:sticky lg:top-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Resumo</p>
        <p className="mt-2 font-display text-lg font-extrabold text-slate-900 dark:text-slate-50">NEXAR {planName}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">Plano mensal</p>
        <div className="my-4 border-t border-slate-100 dark:border-slate-800" />
        <dl className="space-y-2 text-sm">
          {dueDate && (
            <div className="flex justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">Vencimento</dt>
              <dd className="font-medium text-slate-800 dark:text-slate-100">{formatDue(dueDate)}</dd>
            </div>
          )}
          <div className="flex items-end justify-between gap-3 pt-1">
            <dt className="font-semibold text-slate-900 dark:text-slate-50">Total hoje</dt>
            <dd className="tnum font-display text-2xl font-black text-slate-900 dark:text-slate-50">{amountLabel}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          O plano é ativado assim que o pagamento é confirmado.
        </p>
      </aside>
    </div>,
  );
}
