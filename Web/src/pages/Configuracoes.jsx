import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useTheme } from "@/lib/ThemeContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowLeft, Sun, Moon, Monitor, Check, Smartphone, ShieldAlert,
  Eye, MessageCircle, HelpCircle, Flag, Lightbulb, FileText, Cookie, AlertTriangle,
  Loader2, SlidersHorizontal, Mail, Database, PhoneCall, Bell,
} from "lucide-react";
import ChangePasswordSection from "@/components/settings/ChangePasswordSection";
import { version as appVersion } from "../../package.json";

const THEME_OPTIONS = [
  { value: "light", label: "Claro", icon: Sun, description: "Sempre usar o tema claro." },
  { value: "dark", label: "Escuro", icon: Moon, description: "Sempre usar o tema escuro." },
  { value: "system", label: "Seguir sistema", icon: Monitor, description: "Usa a preferência do seu dispositivo." },
];

export default function Configuracoes() {
  const { user, isLoadingAuth, authChecked } = useAuth();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Mesmo padrão de guarda de autenticação já usado em Dashboard.jsx/AdEditor.jsx.
  useEffect(() => {
    if (authChecked && !user) {
      api.auth.redirectToLogin("/Configuracoes");
    }
  }, [authChecked, user]);

  // next-themes só sabe o tema real depois de montar no cliente -- evita
  // mostrar/aplicar um estado errado por uma fração de segundo.
  useEffect(() => {
    setMounted(true);
  }, []);

  const isFornecedor = user?.role === "fornecedor" || user?.role === "admin";

  if (isLoadingAuth || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center gap-4">
          <Link to={createPageUrl("Conta")}>
            <Button variant="ghost" size="sm" className="text-slate-500 dark:text-slate-400 gap-1.5">
              <ArrowLeft className="w-4 h-4" /> Minha Conta
            </Button>
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="font-display font-extrabold text-slate-900 dark:text-slate-50">Configurações</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Gerencie as preferências e configurações da sua conta.
          </p>
        </div>

        {/* Aparência */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Aparência</CardTitle>
            <CardDescription>Como o NEXAR é exibido neste dispositivo.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Tema do sistema</p>
            </div>
            <div className="grid sm:grid-cols-3 gap-3" role="radiogroup" aria-label="Tema do sistema">
              {THEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const selected = mounted && theme === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(opt.value)}
                    className={`relative text-left p-4 rounded-card border-2 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900 ${
                      selected
                        ? "border-orange-500 bg-orange-50 dark:bg-orange-500/10"
                        : "border-slate-100 dark:border-slate-800 hover:border-slate-200 dark:hover:border-slate-700"
                    }`}
                  >
                    {selected && (
                      <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center">
                        <Check className="w-3 h-3 text-white" />
                      </span>
                    )}
                    <Icon className={`w-5 h-5 mb-2 ${selected ? "text-orange-500" : "text-slate-400 dark:text-slate-500"}`} />
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{opt.label}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{opt.description}</p>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* Notificações. Eram 5 chaves (mensagens, orçamentos, avaliações,
            novidades, e-mail) salvas no navegador que NADA lia: desligar
            "Novas mensagens" não mudava coisa alguma, e o NEXAR não manda
            e-mail. Trocadas pelo que existe de verdade (seção 169). */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Notificações</CardTitle>
            <CardDescription>
              Mensagens recebidas e avisos do seu plano aparecem na central de notificações.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <Link
              to={createPageUrl("Notificacoes")}
              className="flex items-center gap-3 py-2.5 text-sm font-medium text-slate-700 hover:text-orange-600 dark:text-slate-300 dark:hover:text-orange-400"
            >
              <div className="w-9 h-9 rounded-card bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center shrink-0">
                <Bell className="w-4 h-4 text-orange-500" />
              </div>
              Abrir a central de notificações
            </Link>
            <ComingSoonRow icon={SlidersHorizontal} label="Escolher quais avisos receber" />
            <ComingSoonRow icon={Mail} label="Avisos por e-mail" />
          </CardContent>
        </Card>

        {/* Segurança */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Segurança</CardTitle>
            <CardDescription>Senha e acesso à sua conta.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ChangePasswordSection user={user} />

            <Separator />

            <ComingSoonRow icon={Smartphone} label="Sessões e dispositivos" />
            <ComingSoonRow icon={ShieldAlert} label="Autenticação em dois fatores" />
          </CardContent>
        </Card>

        {/* Privacidade */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Privacidade</CardTitle>
            <CardDescription>O que fica visível para outras pessoas.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Só fornecedor tem perfil público. O texto também listava o
                "site da empresa", que o perfil não mostra, e o telefone sem
                dizer que só aparece para quem está logado. */}
            {isFornecedor && (
            <div className="rounded-card border border-slate-100 dark:border-slate-800 p-4 space-y-1.5">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-orange-500" />
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Perfil público da empresa</p>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Quando sua empresa tem um anúncio ativo, o perfil público mostra somente dados
                comerciais: nome, segmento, cidade/UF, logo e capa, descrição (conforme o plano) e
                avaliações; o telefone aparece só para quem está logado. Seu nome completo e o
                e-mail de login nunca são exibidos publicamente.
              </p>
            </div>
            )}
            <ComingSoonRow icon={PhoneCall} label="Preferências de contato" />
            <ComingSoonRow icon={Database} label="Gerenciar meus dados" />
          </CardContent>
        </Card>

        {/* Suporte */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Suporte</CardTitle>
            <CardDescription>Ajuda e contato com a equipe do NEXAR.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <ComingSoonRow icon={HelpCircle} label="Central de ajuda" />
            <ComingSoonRow icon={MessageCircle} label="Falar com o suporte" />
            <ComingSoonRow icon={Flag} label="Reportar um problema" />
            <ComingSoonRow icon={Lightbulb} label="Enviar sugestão" />
          </CardContent>
        </Card>

        {/* Sobre o NEXAR */}
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Sobre o NEXAR</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-bold text-slate-900 dark:text-slate-50 tracking-wide">
                NE<span className="text-orange-500">X</span>AR
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                Conectando empresas aos fornecedores certos.
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Versão {appVersion}</p>
            </div>
            <Separator />
            <ComingSoonRow icon={FileText} label="Termos de uso" />
            <ComingSoonRow icon={FileText} label="Política de privacidade" />
            <ComingSoonRow icon={Cookie} label="Política de cookies" />
          </CardContent>
        </Card>

        {/* Zona de perigo */}
        <Card className="rounded-card border border-red-200 dark:border-red-900/50 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-red-600 dark:text-red-400">Zona de perigo</CardTitle>
            <CardDescription>Ações permanentes, que não podem ser desfeitas.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-card bg-red-50 dark:bg-red-500/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="w-4 h-4 text-red-500" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-300">Excluir minha conta</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    Remove sua conta e todos os dados associados permanentemente.
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                title="Exclusão de conta será disponibilizada em breve, com um fluxo seguro para todos os seus dados."
                className="rounded-card border-red-200 dark:border-red-900/50 text-red-500 dark:text-red-400 gap-1.5 opacity-60 cursor-not-allowed"
              >
                Em breve
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ComingSoonRow({ icon: Icon, label }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 opacity-60">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-card bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-slate-400 dark:text-slate-500" />
        </div>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300 truncate">{label}</p>
      </div>
      <Badge
        variant="outline"
        className="text-[11px] shrink-0 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400"
      >
        Em breve
      </Badge>
    </div>
  );
}
