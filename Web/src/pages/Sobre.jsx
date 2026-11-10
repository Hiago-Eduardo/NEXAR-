import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import {
  Compass,
  Search,
  MessageCircle,
  ShieldCheck,
  Building2,
  Store,
  BadgeCheck,
} from "lucide-react";
import Footer from "../components/shared/Footer";

const pillars = [
  {
    icon: Search,
    title: "Encontrar",
    description:
      "Pesquise fornecedores por categoria, cidade, estado ou nome da empresa e compare as opções encontradas.",
  },
  {
    icon: MessageCircle,
    title: "Conversar",
    description:
      "Fale direto com o fornecedor pelo chat ou envie um pedido de orçamento, sem intermediários.",
  },
  {
    icon: ShieldCheck,
    title: "Decidir com confiança",
    description:
      "Veja avaliações, selo de verificação e informações da empresa antes de fechar negócio.",
  },
];

export default function Sobre() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-orange-50 dark:bg-orange-500/10 border border-orange-100 dark:border-orange-900/50 text-orange-600 dark:text-orange-400 text-xs font-medium mb-4">
            <Compass className="w-3.5 h-3.5" />
            Sobre o NEXAR
          </div>
          <h1 className="mb-3 font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">
            Conectando empresas aos fornecedores certos
          </h1>
          <p className="text-slate-500 dark:text-slate-400 text-lg max-w-2xl mx-auto">
            NEXAR é uma vitrine digital que ajuda empresas e microempreendedores a encontrar,
            comparar e entrar em contato com fornecedores.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-6 py-16 space-y-16">
        {/* O que é */}
        <section>
          {/* Mesma tipografia dos outros títulos da página (e da Home): este
              era o único em text-2xl/bold, parecia de outro site. */}
          <h2 className="mb-4 font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50">
            O que é o NEXAR
          </h2>
          <p className="text-slate-600 dark:text-slate-300 leading-relaxed mb-4">
            Muitas empresas e microempreendedores perdem tempo buscando fornecedores por indicação,
            sem conseguir comparar preços, condições ou reputação de forma organizada. O NEXAR existe
            para resolver esse problema: uma plataforma onde fornecedores publicam seus anúncios e
            empresas clientes podem pesquisar, comparar e entrar em contato diretamente.
          </p>
          <div className="rounded-card border border-orange-100 dark:border-orange-900/40 bg-orange-50 dark:bg-orange-500/10 p-5 flex gap-3">
            <BadgeCheck className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
            <p className="text-sm text-orange-800 dark:text-orange-300 leading-relaxed">
              <strong>O NEXAR não é um marketplace.</strong> Não existe compra dentro da plataforma —
              o contato, a negociação e o fechamento do pedido acontecem diretamente entre a empresa
              cliente e o fornecedor.
            </p>
          </div>
        </section>

        {/* Como funciona */}
        <section>
          <h2 className="mb-8 font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50">
            Como funciona
          </h2>
          <div className="grid sm:grid-cols-3 gap-6">
            {pillars.map((pillar) => {
              const Icon = pillar.icon;
              return (
                <div
                  key={pillar.title}
                  className="rounded-card border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 p-6"
                >
                  {/* Os três pilares tinham uma cor cada (azul/esmeralda/
                      âmbar) -- mesmo padrão decorativo sem significado que foi
                      removido do resto do site (seção 78). */}
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-orange-50 dark:bg-orange-500/10">
                    <Icon className="h-6 w-6 text-orange-500" />
                  </div>
                  <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">{pillar.title}</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                    {pillar.description}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Pra quem é */}
        <section>
          <h2 className="mb-8 font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50">
            Para quem é o NEXAR
          </h2>
          <div className="grid sm:grid-cols-2 gap-6">
            <div className="rounded-card border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
              <div className="w-12 h-12 rounded-card bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center mb-4">
                <Building2 className="w-6 h-6 text-orange-500" />
              </div>
              <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">Empresas clientes</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                Encontre fornecedores por categoria, cidade ou estado, compare informações e
                avaliações, e entre em contato sem depender só de indicações.
              </p>
            </div>
            <div className="rounded-card border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
              <div className="w-12 h-12 rounded-card bg-orange-50 dark:bg-orange-500/10 flex items-center justify-center mb-4">
                <Store className="w-6 h-6 text-orange-500" />
              </div>
              <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-2">Empresas fornecedoras</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                Cadastre sua empresa gratuitamente e publique anúncios para ganhar visibilidade
                junto a empresas em busca do que você oferece.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden rounded-card bg-slate-950 px-8 py-14 text-center">
          <div className="absolute inset-x-0 top-0 h-1 bg-orange-500" />
          <h2 className="font-display text-3xl font-black tracking-tight text-white md:text-4xl">
            Quer conhecer os fornecedores?
          </h2>
          <p className="mx-auto mb-8 mt-3 max-w-xl text-slate-400">
            Pesquise por categoria, cidade ou nome da empresa e comece a comparar agora mesmo.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link to={createPageUrl("Suppliers")}>
              <Button className="h-12 rounded-card bg-orange-500 px-8 text-base font-bold text-white hover:bg-orange-600">
                Ver fornecedores
              </Button>
            </Link>
            <Link to={createPageUrl("Register")}>
              <Button
                variant="outline"
                className="h-12 px-8 rounded-card border-white/40 text-white hover:bg-white/10 font-bold text-base"
              >
                Cadastrar como fornecedor
              </Button>
            </Link>
          </div>
        </section>
      </div>

      <Footer />
    </div>
  );
}
