import React from "react";
import { motion } from "framer-motion";
import { Search, Handshake, Rocket } from "lucide-react";

// Os três passos tinham uma cor cada (azul / esmeralda / roxo) sem que a cor
// significasse nada -- mesmo problema do CategoryGrid. Agora o que diferencia
// os passos é o NÚMERO, que é o dado real da sequência, em peso 900 e escala
// grande. Ver CONTEXTO.MD/Resumo.md seção 75.
const steps = [
  {
    icon: Search,
    title: "Pesquise",
    description:
      "Busque fornecedores por categoria, localização ou produto. Use filtros para encontrar exatamente o que precisa.",
  },
  {
    icon: Handshake,
    title: "Conecte-se",
    description:
      "Entre em contato direto com fornecedores, envie mensagens e solicite orçamentos sem intermediários.",
  },
  {
    icon: Rocket,
    title: "Cresça",
    description:
      "Feche parcerias, avalie fornecedores e construa uma rede confiável para escalar seu negócio.",
  },
];

export default function HowItWorks() {
  return (
    <section className="bg-white px-6 py-20 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl">
        <motion.div
          className="mb-12 max-w-xl"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
        >
          <h2 className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">
            Como funciona
          </h2>
          <p className="mt-2 text-slate-500 dark:text-slate-400">
            Três passos simples para encontrar o fornecedor ideal.
          </p>
        </motion.div>

        <div className="grid gap-px overflow-hidden rounded-card border border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800 md:grid-cols-3">
          {steps.map((step, index) => (
            <motion.div
              key={step.title}
              className="bg-white p-7 dark:bg-slate-900"
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.08, duration: 0.3 }}
            >
              <div className="mb-5 flex items-center gap-3">
                <span className="tnum font-display text-5xl font-black leading-none text-orange-500">
                  {index + 1}
                </span>
                <span className="flex h-9 w-9 items-center justify-center rounded-card bg-orange-50 text-orange-500 dark:bg-orange-500/10 dark:text-orange-400">
                  <step.icon className="h-4 w-4" />
                </span>
              </div>
              <h3 className="mb-2 font-display text-xl font-extrabold text-slate-900 dark:text-slate-50">
                {step.title}
              </h3>
              <p className="leading-relaxed text-slate-500 dark:text-slate-400">
                {step.description}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
