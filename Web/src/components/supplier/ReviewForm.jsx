import React, { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Star, Loader2, CheckCircle, AlertTriangle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { Panel } from "../shared/Panel";

/** Traduz os erros que este formulário pode receber. `SELF_REVIEW_NOT_ALLOWED`
 *  vem do trigger enforce_review_rules (supabase/review-rating-sync.sql);
 *  o 42501 é a RLS recusando um insert sem sessão válida. */
function messageForError(error) {
  const raw = `${error?.message || ""} ${error?.code || ""}`;
  if (raw.includes("SELF_REVIEW_NOT_ALLOWED")) {
    return "Você não pode avaliar o seu próprio anúncio.";
  }
  if (raw.includes("42501") || raw.toLowerCase().includes("row-level security")) {
    return "Sua sessão expirou. Entre novamente para enviar a avaliação.";
  }
  return "Não foi possível enviar sua avaliação. Tente novamente.";
}

export default function ReviewForm({ supplierId, supplierName }) {
  const { isAuthenticated } = useAuth();
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [reviewerName, setReviewerName] = useState("");
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const queryClient = useQueryClient();

  const mutation = useMutation({
    // O recálculo da média NÃO é mais feito aqui. A versão anterior gravava a
    // avaliação e em seguida chamava Supplier.update() com rating/
    // total_reviews -- escrita que a policy "Owners can update suppliers"
    // sempre negou para quem não é dono do anúncio, ou seja, para todo
    // avaliador legítimo. O insert passava, o update falhava, e a nota ficava
    // parada em 0. Agora quem recalcula é o trigger
    // reviews_sync_supplier_rating, no banco -- ver
    // supabase/review-rating-sync.sql e a seção 97 do Resumo.md.
    mutationFn: (data) => api.entities.Review.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews", supplierId] });
      queryClient.invalidateQueries({ queryKey: ["supplier", supplierId] });
      // A nota exibida é derivada das avaliações e acabou de mudar no banco.
      queryClient.invalidateQueries({ queryKey: ["company-reviews"] });
      setSubmitted(true);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (rating === 0) return;
    mutation.mutate({
      supplier_id: supplierId,
      reviewer_name: reviewerName || "Anônimo",
      rating,
      comment,
    });
  };

  // O formulário aparecia para QUALQUER visitante, inclusive sem conta -- mas
  // a policy de insert em reviews é `to authenticated`. Sem sessão, o envio
  // era recusado pelo banco e, como a mutation não tinha tratamento de erro,
  // o botão simplesmente voltava ao normal sem dizer nada. Agora o estado
  // deslogado é explícito e vira convite de cadastro.
  if (!isAuthenticated) {
    return (
      <Panel bodyClassName="p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400">
          <Lock className="h-5 w-5" />
        </div>
        <p className="font-semibold text-slate-800 dark:text-slate-100">
          Avalie {supplierName}
        </p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-slate-500 dark:text-slate-400">
          Crie sua conta gratuita para avaliar este fornecedor e ajudar outros
          compradores a decidir.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Link to={createPageUrl("Register")}>
            <Button className="h-10 rounded-card bg-orange-500 px-5 font-semibold text-white hover:bg-orange-600">
              Criar conta gratuita
            </Button>
          </Link>
          <Link to={createPageUrl("Login")}>
            <Button variant="outline" className="h-10 rounded-card px-5 font-semibold">
              Já tenho conta
            </Button>
          </Link>
        </div>
      </Panel>
    );
  }

  if (submitted) {
    return (
      <Panel bodyClassName="p-6 text-center">
        {/* Verde sobrevive aqui de propósito: é confirmação semântica real
            (envio concluído), não uma segunda cor de destaque decorativa --
            ver a regra da seção 71. */}
        <CheckCircle className="mx-auto mb-3 h-10 w-10 text-emerald-500" />
        <p className="font-semibold text-slate-800 dark:text-slate-100">Avaliação enviada!</p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Obrigado pelo seu feedback.</p>
      </Panel>
    );
  }

  // Titulo curto, nao `Avaliar ${supplierName}`: com nome longo ele quebrava
  // em duas linhas coladas dentro do cabecalho do painel. O nome do
  // fornecedor ja esta no banner, no breadcrumb e no card de orcamento --
  // repeti-lo aqui custava legibilidade e nao informava nada.
  return (
    <Panel title="Avaliar este fornecedor" icon={Star}>
      <form onSubmit={handleSubmit} className="space-y-4">
          {/* Star Rating */}
          <div>
            <Label className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2 block">Sua nota *</Label>
            <div className="flex items-center gap-1">
              {Array.from({ length: 5 }).map((_, i) => {
                const value = i + 1;
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setRating(value)}
                    onMouseEnter={() => setHovered(value)}
                    onMouseLeave={() => setHovered(0)}
                    className="transition-transform hover:scale-110"
                  >
                    <Star
                      className={`w-8 h-8 transition-colors ${
                        value <= (hovered || rating)
                          ? "text-orange-500 fill-orange-500"
                          : "text-slate-200 dark:text-slate-700 fill-slate-200 dark:fill-slate-700"
                      }`}
                    />
                  </button>
                );
              })}
              {rating > 0 && (
                <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                  {["", "Péssimo", "Ruim", "Regular", "Bom", "Excelente"][rating]}
                </span>
              )}
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Seu nome</Label>
            <Input
              value={reviewerName}
              onChange={(e) => setReviewerName(e.target.value)}
              placeholder="Nome (opcional)"
              className="mt-1.5 h-10 rounded-card"
            />
          </div>

          <div>
            <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Comentário</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Conte sua experiência com este fornecedor..."
              className="mt-1.5 h-24 rounded-card"
            />
          </div>

          {/* A mutation não tinha NENHUM tratamento de erro: qualquer recusa do
              banco (RLS, trigger, rede) apenas devolvia o botão ao estado
              normal, sem mensagem -- o avaliador achava que tinha enviado. */}
          {mutation.isError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-card border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{messageForError(mutation.error)}</span>
            </div>
          )}

          <Button
            type="submit"
            disabled={rating === 0 || mutation.isPending}
            className="h-10 w-full rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600"
          >
            {mutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Enviar Avaliação"
            )}
          </Button>
      </form>
    </Panel>
  );
}