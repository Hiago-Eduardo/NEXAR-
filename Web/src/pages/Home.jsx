import React from "react";
import { api } from "@/api/client";
import { useQuery } from "@tanstack/react-query";
import HeroSection from "../components/home/HeroSection";
import CategoryGrid from "../components/home/CategoryGrid";
import FeaturedSuppliers from "../components/home/FeaturedSuppliers";
import HowItWorks from "../components/home/HowItWorks";
import CTASection from "../components/home/CTASection";
import Footer from "../components/shared/Footer";

export default function Home() {
  // Sem `initialData: []`: além de deixar `isLoading` sempre false (o esqueleto de
  // FeaturedSuppliers virava código morto e a seção abria direto no estado vazio),
  // ele faz a query voltar vazia e NÃO refazer a busca sempre que o cache é
  // esvaziado por baixo do observer -- o que o AuthContext faz ao trocar de conta.
  // Mesmo defeito que já havia mordido em Suppliers.jsx (seção 96) e que deixava a
  // lista de avaliações vazia no SupplierProfile (seção 103).
  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers-featured"],
    // Via RPC pública: anon perdeu o select direto em `suppliers`
    // (supabase/anon-content-gate.sql) e recebe a amostra limitada.
    queryFn: () => api.catalog.listSuppliers({ limit: 50 }),
  });

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <HeroSection />
      <CategoryGrid />
      <FeaturedSuppliers suppliers={suppliers} isLoading={isLoading} />
      <HowItWorks />
      <CTASection />
      <Footer />
    </div>
  );
}