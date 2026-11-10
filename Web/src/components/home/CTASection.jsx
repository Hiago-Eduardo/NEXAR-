import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  ArrowRight, Store, Search, UserPlus, CreditCard, Megaphone,
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";

// Duas trilhas (cliente/fornecedor) num toggle por CLIQUE, não hover -- hover não
// existe em toque (celular), então não dá pra depender dele como gatilho aqui.
// Reaproveita o mesmo padrão de toggle já usado em Suppliers.jsx (abas
// "Anúncios"/"Empresas"), consistente com o resto do site.
const TRACKS = {
  fornecedor: {
    icon: Store,
    title: "É fornecedor?",
    highlight: "Cadastre-se gratuitamente",
    description: "Alcance milhares de micro empreendedores buscando novos fornecedores. Crie seu perfil e receba solicitações de orçamento.",
    steps: [
      { icon: UserPlus, label: "Cadastre-se grátis" },
      { icon: CreditCard, label: "Escolha um plano" },
      { icon: Megaphone, label: "Publique seu anúncio" },
    ],
    ctaLabel: "Cadastrar como Fornecedor",
    ctaTo: "Register",
  },
  cliente: {
    icon: Search,
    title: "É cliente?",
    highlight: "Comece a buscar agora",
    description: "Encontre fornecedores confiáveis por categoria, localização ou produto e fale direto com eles, sem intermediários.",
    // SEM `steps` de propósito (ver Resumo.md seção 90). Os passos desta
    // trilha eram Pesquise / Conecte-se / Cresça -- exatamente os mesmos da
    // seção "Como funciona", que fica logo acima na página. O visitante
    // deslogado lia as três palavras duas vezes com poucos pixels de
    // distância. Aqui o trabalho é converter, não explicar: a explicação já
    // aconteceu. A trilha do fornecedor MANTÉM os passos porque ali eles são
    // informação nova (mostram que existe um plano no caminho).
    ctaLabel: "Ver Fornecedores",
    ctaTo: "Suppliers",
  },
};

export default function CTASection() {
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState("fornecedor");

  // Quem já tem conta não precisa de um convite pra criar uma -- some da Home
  // inteira nesse caso (ver seção 61 do histórico).
  if (isAuthenticated) return null;

  const track = TRACKS[tab];
  const TrackIcon = track.icon;

  return (
    <section className="relative overflow-hidden bg-slate-950 px-6 py-24">
      {/* Fundo chapado: saíram o degradê de três paradas e o radial laranja
          sobreposto -- mesmo tratamento do hero (seção 75). */}
      <div className="absolute inset-x-0 top-0 h-1 bg-orange-500" />
      <div className="max-w-3xl mx-auto text-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          {/* Fornecedor vem PRIMEIRO e é o padrão. Antes "Sou Cliente"
              aparecia à esquerda mas quem vinha marcado era "Sou
              Fornecedor" -- lia como descuido. A escolha do padrão é de
              negócio (o fornecedor é quem paga, e oferta é o gargalo hoje);
              a ordem agora acompanha essa escolha. */}
          <div className="mb-10 inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
            <button
              type="button"
              onClick={() => setTab("fornecedor")}
              className={`flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors ${
                tab === "fornecedor" ? "bg-orange-500 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              <Store className="w-4 h-4" />
              Sou Fornecedor
            </button>
            <button
              type="button"
              onClick={() => setTab("cliente")}
              className={`flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-bold transition-colors ${
                tab === "cliente" ? "bg-orange-500 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              <Search className="w-4 h-4" />
              Sou Cliente
            </button>
          </div>

          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3 }}
            >
              <div className="mx-auto mb-8 flex h-14 w-14 items-center justify-center rounded-card bg-orange-500/15">
                <TrackIcon className="w-8 h-8 text-orange-400" />
              </div>
              <h2 className="mb-6 font-display text-3xl font-black leading-tight tracking-tight text-white md:text-5xl">
                {track.title}{" "}
                <span className="text-orange-500">{track.highlight}</span>
              </h2>
              <p className="text-slate-400 text-lg mb-10 max-w-xl mx-auto">
                {track.description}
              </p>

              {/* Trilha sem passos (cliente) pula o bloco inteiro em vez de
                  renderizar uma fileira vazia. */}
              {track.steps?.length > 0 && (
              <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 mb-10">
                {track.steps.map((step, i) => {
                  const StepIcon = step.icon;
                  return (
                    <React.Fragment key={step.label}>
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex h-12 w-12 items-center justify-center rounded-card border border-white/10 bg-white/5">
                          <StepIcon className="w-5 h-5 text-orange-400" />
                        </div>
                        <span className="text-sm text-slate-300">{step.label}</span>
                      </div>
                      {i < track.steps.length - 1 && (
                        <ArrowRight className="w-4 h-4 text-slate-600 hidden sm:block" />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
              )}

              <Link to={createPageUrl(track.ctaTo)}>
                <Button className="h-14 rounded-card px-10 text-base font-bold text-white bg-orange-500 hover:bg-orange-600">
                  {track.ctaLabel}
                  <ArrowRight className="w-5 h-5 ml-2" />
                </Button>
              </Link>
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  );
}
