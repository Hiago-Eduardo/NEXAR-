import React, { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Send, Loader2, CheckCircle, LogIn } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { useCaptcha } from "@/components/shared/Turnstile";
import { contactCaptchaEnabled } from "@/lib/turnstile";

// Orçamento com Turnstile (§228): só depois de publicar a Edge Function
// submit-contact-request e rodar o SQL. Desligado, segue o insert direto.
const CAPTCHA_NO_ORCAMENTO = contactCaptchaEnabled();

export default function ContactForm({ supplierId, supplierName }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState({
    sender_name: "",
    sender_email: "",
    sender_phone: "",
    message: "",
  });
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const captcha = useCaptcha({ action: "contact_request", enabled: CAPTCHA_NO_ORCAMENTO });

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!captcha.canSubmit) return;
    setSending(true);
    try {
      if (CAPTCHA_NO_ORCAMENTO) {
        // A função confere o CAPTCHA E grava; o token é de uso único.
        await api.contactRequests.submit({ ...form, supplierId, captchaToken: captcha.consume() });
      } else {
        await api.entities.ContactRequest.create({
          ...form,
          supplier_id: supplierId,
        });
      }
      setSent(true);
    } catch (error) {
      toast({
        title: "Não foi possível enviar sua mensagem",
        description: error.message || "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  // Só quem tem conta pode criar um ContactRequest (api.entities.create exige
  // sessão) -- avisa antes de preencher o formulário em vez de deixar
  // descobrir só no envio.
  if (!user) {
    return (
      <div className="text-center py-6 px-2">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center">
          <LogIn className="w-6 h-6 text-slate-400 dark:text-slate-500" />
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
          Crie uma conta gratuita ou faça login para solicitar um orçamento de {supplierName}.
        </p>
        <Link to={createPageUrl("Register")}>
          <Button variant="outline" className="rounded-card w-full">
            Criar conta / Entrar
          </Button>
        </Link>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="text-center py-8">
        <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-orange-50 flex items-center justify-center">
          <CheckCircle className="w-7 h-7 text-orange-500" />
        </div>
        <h3 className="font-semibold text-slate-900 dark:text-slate-50 mb-1">Mensagem enviada!</h3>
        <p className="text-slate-500 dark:text-slate-400 text-sm">
          {supplierName} receberá sua solicitação em breve.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="name" className="text-sm text-slate-600 dark:text-slate-300">Seu Nome</Label>
        <Input
          id="name"
          required
          value={form.sender_name}
          onChange={(e) => setForm({ ...form, sender_name: e.target.value })}
          placeholder="Nome completo"
          className="mt-1 rounded-card"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="email" className="text-sm text-slate-600 dark:text-slate-300">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={form.sender_email}
            onChange={(e) => setForm({ ...form, sender_email: e.target.value })}
            placeholder="seu@email.com"
            className="mt-1 rounded-card"
          />
        </div>
        <div>
          <Label htmlFor="phone" className="text-sm text-slate-600 dark:text-slate-300">Telefone</Label>
          <Input
            id="phone"
            value={form.sender_phone}
            onChange={(e) => setForm({ ...form, sender_phone: e.target.value })}
            placeholder="(00) 00000-0000"
            className="mt-1 rounded-card"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="message" className="text-sm text-slate-600 dark:text-slate-300">Mensagem</Label>
        <Textarea
          id="message"
          required
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          placeholder="Descreva o que você precisa, quantidades, prazos..."
          className="mt-1 rounded-card h-28"
        />
      </div>
      {captcha.widget}
      <Button
        type="submit"
        disabled={sending || !captcha.canSubmit}
        className="w-full h-12 rounded-card bg-orange-500 hover:bg-orange-600 text-white font-semibold"
      >
        {sending ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <>
            <Send className="w-4 h-4 mr-2" />
            Enviar Mensagem
          </>
        )}
      </Button>
    </form>
  );
}