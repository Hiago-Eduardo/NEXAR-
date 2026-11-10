import React, { useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Search, MapPin, Tag } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { api } from "@/api/client";
import { CATEGORIES } from "@/lib/categories";

const categories = [
  { value: "", label: "Todas as categorias" },
  ...CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
];

export default function HeroSection() {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const navigate = useNavigate();

  // Números reais (não estimativas de marketing) -- suppliers/reviews já são
  // tabelas públicas, então dá pra contar sem RPC nova. "Empreendedores"
  // (contagem de user_profiles por user_type) precisaria de uma RPC nova
  // porque user_profiles não é público -- trocado por "Avaliações" em vez de
  // inventar/estimar esse número.
  const { data: supplierCount = 0 } = useQuery({
    queryKey: ["stats-supplier-count"],
    queryFn: () => api.catalog.countSuppliers(),
  });
  const { data: reviewCount = 0 } = useQuery({
    queryKey: ["stats-review-count"],
    queryFn: () => api.entities.Review.count(),
  });

  // A escolha entre buscar ANÚNCIOS ou EMPRESAS virou uma aba na própria
  // barra (antes era um link solto "ou busque por empresa" embaixo, que ficava
  // deslocado e não deixava claro que mudava o tipo de resultado). É o mesmo
  // par de abas da página de resultados -- o usuário reencontra o controle no
  // mesmo formato nos dois lugares.
  const [tab, setTab] = useState("anuncios");

  const handleSearch = () => {
    const params = new URLSearchParams();
    if (name.trim()) params.set("search", name.trim());
    if (category) params.set("category", category);
    if (city.trim()) params.set("city", city.trim());
    if (tab === "empresas") params.set("tab", "empresas");
    navigate(createPageUrl("Suppliers") + (params.toString() ? `?${params}` : ""));
  };

  // Métrica zerada não entra: com o catálogo no começo, "0 Avaliações" em
  // numeral peso 900 na primeira tela chamava atenção justamente para o que
  // falta (ver Resumo.md seção 91). O filtro é geral, não um caso especial
  // de "Avaliações" -- quando houver avaliações o número reaparece sozinho,
  // e o mesmo vale para qualquer métrica que venha a zerar.
  const stats = [
    { value: supplierCount, label: "Fornecedores" },
    { value: reviewCount, label: "Avaliações" },
    { value: CATEGORIES.length, label: "Categorias" },
  ].filter((stat) => Number(stat.value) > 0);

  return (
    /*
     * Hero reescrito (ver CONTEXTO.MD/Resumo.md seção 75). Saíram os três
     * clichês que mais marcavam a tela como gerada: dois orbes laranja
     * animados em loop infinito com blur-3xl, o título com texto em degradê
     * (orange-400 -> amber-300) e o painel de busca em glassmorphism
     * (bg-white/10 + backdrop-blur).
     *
     * O fundo continua escuro -- dá contraste ao branco das seções seguintes
     * e a paleta nova deixou o "preto" quente (#120F0D), não azulado --, mas
     * agora é chapado. A busca vive na própria superfície escura (ver o
     * comentário no bloco de busca, seção 83).
     */
    <section className="relative overflow-hidden bg-slate-950 pb-28 pt-28 md:pb-36 md:pt-36">
      {/* Fio laranja no topo -- único ornamento, e alinhado com o sistema */}
      <div className="absolute inset-x-0 top-0 h-1 bg-orange-500" />

      <div className="relative mx-auto max-w-site px-6">
        <div className="max-w-3xl">
          <motion.p
            className="label-mono mb-5 flex items-center gap-2 text-orange-400"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
          >
            <span className="h-1.5 w-1.5 bg-orange-500" />
            Diretório B2B de fornecedores
          </motion.p>

          {/* Entrelinha e espacejamento afrouxados: em peso 900 no tamanho
              7xl, o leading-[0.95] + tracking-tighter original fazia as
              linhas quase se encostarem e as palavras "grudarem". Texto
              grande e pesado precisa de MAIS ar, não menos. */}
          <motion.h1
            className="font-display text-4xl font-black leading-[1.2] tracking-normal text-white sm:text-5xl md:text-6xl"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
          >
            Encontre os melhores{" "}
            <span className="text-orange-500">fornecedores</span> para o seu negócio
          </motion.h1>

          {/* mt-8: eu tinha REDUZIDO para mt-5 na passada anterior, o que
              piorou justamente a queixa de "muito junto". Subtítulo depois de
              um título em peso 900 precisa de respiro grande, senão os dois
              blocos leem como um só. */}
          <motion.p
            className="mt-8 max-w-xl text-lg leading-loose text-slate-400"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.12 }}
          >
            Conectamos micro empreendedores a fornecedores confiáveis. Pesquise,
            compare e fale direto, sem intermediários.
          </motion.p>
        </div>

        {/* ============================ BUSCA ============================
            Desenho escolhido pelo usuário: campo principal grande sozinho na
            primeira linha, e categoria/cidade/botão numa segunda linha com
            peso menor. As duas tentativas anteriores falharam por espremer
            os três campos lado a lado -- o select de categoria ficava
            comprimido no meio e o conjunto lia como uma placa solta.

            Fundo: superfície escura, um tom acima do hero (não o painel
            branco, que parecia colado; e não glassmorphism, que era o clichê
            removido na seção 75). */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-12 max-w-3xl"
        >
          {/* Abas: substituem o antigo link solto "ou busque por empresa".
              Mesmo par da página de resultados, então o controle é
              reencontrado no mesmo formato nos dois lugares. */}
          <div className="mb-3 flex gap-6 border-b border-white/10">
            {[
              { id: "anuncios", label: "Anúncios" },
              { id: "empresas", label: "Empresas" },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`-mb-px border-b-2 pb-2.5 text-sm font-bold transition-colors ${
                  tab === t.id
                    ? "border-orange-500 text-orange-400"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Linha 1 -- campo principal, alto e sozinho */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder={
                tab === "empresas" ? "Nome da empresa…" : "Nome da empresa ou produto…"
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="h-16 w-full rounded-card border border-white/15 bg-white/5 pl-14 pr-4 text-base text-white placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
            />
          </div>

          {/* Linha 2 -- filtros secundários + ação */}
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Tag className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-12 w-full cursor-pointer appearance-none rounded-card border border-white/15 bg-white/5 pl-11 pr-8 text-sm text-white focus:border-orange-500/60 focus:outline-none"
              >
                {categories.map((c) => (
                  <option key={c.value} value={c.value} className="bg-slate-900 text-white">
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="relative flex-1">
              <MapPin className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                placeholder="Cidade ou estado"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="h-12 w-full rounded-card border border-white/15 bg-white/5 pl-11 pr-4 text-sm text-white placeholder:text-slate-500 focus:border-orange-500/60 focus:outline-none"
              />
            </div>

            <Button
              onClick={handleSearch}
              className="h-12 shrink-0 gap-2 rounded-card bg-orange-500 px-8 text-sm font-bold text-white hover:bg-orange-600"
            >
              <Search className="h-4 w-4" />
              Buscar
            </Button>
          </div>
        </motion.div>

        {/* Números reais. Antes eram três cartões de vidro com ícone; agora é
            uma régua tipográfica -- o número é o dado, não a moldura. */}
        <motion.dl
          className="mt-10 flex flex-wrap items-center gap-x-10 gap-y-5 border-t border-white/10 pt-8"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          {stats.map((stat) => (
            <div key={stat.label}>
              <dd className="tnum font-display text-4xl font-black leading-none text-white">
                {stat.value}
              </dd>
              <dt className="label-mono mt-2 text-slate-500">{stat.label}</dt>
            </div>
          ))}
        </motion.dl>
      </div>
    </section>
  );
}
