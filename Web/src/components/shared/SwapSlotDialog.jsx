import React, { useEffect, useState } from "react";
import { api } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { planRuleErrorMessage } from "@/lib/itemStatus";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/**
 * Escolha manual de qual item fica no ar (Resumo.md seção 194): o item
 * suspenso pelo limite do plano (`target`) entra no lugar de um ativo que a
 * pessoa escolhe aqui. O banco faz as duas mudanças juntas (swap_plan_slot),
 * então o número de ativos não muda e o limite nunca é passado.
 *
 * kind: 'ad' | 'product'   noun: "anúncio" | "produto"
 * target: { id, name }     candidates: [{ id, name }] -- os ativos
 */
export default function SwapSlotDialog({ open, onOpenChange, kind, noun, target, candidates, onSwapped }) {
  const { toast } = useToast();
  const [chosen, setChosen] = useState("");
  const [saving, setSaving] = useState(false);

  // Só ao abrir (ou trocar de alvo): `candidates` é recalculado a cada render
  // de quem usa, e depender dele zeraria a escolha enquanto o diálogo está
  // aberto.
  useEffect(() => {
    if (open) setChosen(candidates.length === 1 ? candidates[0].id : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target?.id]);

  const confirm = async () => {
    if (!target || !chosen) return;
    setSaving(true);
    try {
      await api.planLimits.swap(kind, target.id, chosen);
      const saiu = candidates.find((c) => c.id === chosen);
      toast({ title: `${target.name} está no ar`, description: `${saiu?.name || "O outro"} ficou suspenso no lugar dele.` });
      onOpenChange(false);
      onSwapped?.();
    } catch (error) {
      const message = error.message || "";
      toast({
        title: "Não foi possível fazer a troca",
        description: planRuleErrorMessage(message, noun) || message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-card">
        <DialogHeader>
          <DialogTitle>Colocar “{target?.name}” no ar</DialogTitle>
          <DialogDescription>
            Seu plano já está com todos os {noun}s ativos que comporta. Escolha qual {noun} sai do ar
            no lugar dele — ele fica suspenso, sem nada apagado, e você pode trocar de novo quando quiser.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Nenhum {noun} ativo para trocar. Se você pausou algum, a vaga é liberada na próxima
            atualização do plano.
          </p>
        ) : (
          <RadioGroup value={chosen} onValueChange={setChosen} className="max-h-72 overflow-y-auto pr-1">
            {candidates.map((c) => (
              <Label
                key={c.id}
                htmlFor={`swap-${c.id}`}
                className="flex cursor-pointer items-center gap-3 rounded-card border border-slate-200 px-3 py-2.5 font-normal hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <RadioGroupItem id={`swap-${c.id}`} value={c.id} />
                <span className="truncate">{c.name || "Sem nome"}</span>
              </Label>
            ))}
          </RadioGroup>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="rounded-card">
            Voltar
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={!chosen || saving}
            className="rounded-card bg-orange-500 font-semibold text-white hover:bg-orange-600"
          >
            {saving ? "Trocando…" : "Trocar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
