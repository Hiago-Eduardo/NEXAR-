import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ArrowRight } from "lucide-react";
import { CATEGORIES, FOOTER_CATEGORY_KEYS, categoryLabel } from "@/lib/categories";
import { useAuth } from "@/lib/AuthContext";

export default function Footer() {
  const { isAuthenticated } = useAuth();
  // Ano calculado, não escrito no código -- "© 2026" fixo vira mentira em
  // janeiro sem ninguém perceber.
  const year = new Date().getFullYear();

  return (
    /* Borda sutil no lugar do fio laranja (seção 89). O fio é elemento de
       assinatura e estava aparecendo TRÊS vezes na mesma página: topo do
       hero, topo do CTA e topo do rodapé -- repetição suficiente para ele
       deixar de significar alguma coisa. Ficou reservado para a abertura da
       página e para o bloco de conversão.
       A borda também resolve o encontro CTA/rodapé, que são os dois escuros
       e se fundiam num bloco só. */
    <footer className="relative border-t border-white/10 bg-slate-950 px-6 py-16 text-slate-400">
      <div className="max-w-site mx-auto">
        <div className="mb-12 grid gap-10 md:grid-cols-5">
          <div className="md:col-span-2">
            <h3 className="mb-3 font-display text-2xl font-black tracking-widest text-white">
              NE<span className="text-orange-500">X</span>AR
            </h3>
            <p className="text-slate-500 leading-relaxed max-w-sm">
              A plataforma que conecta micro empreendedores a fornecedores confiáveis em todo o Brasil.
            </p>
          </div>
          <div>
            <h4 className="label-mono mb-4 text-slate-500">Navegação</h4>
            <ul className="space-y-2.5">
              <li><Link to={createPageUrl("Home")} className="text-sm transition-colors hover:text-orange-500">Início</Link></li>
              <li><Link to={createPageUrl("Suppliers")} className="text-sm transition-colors hover:text-orange-500">Fornecedores</Link></li>
              <li><Link to={createPageUrl("Planos")} className="text-sm transition-colors hover:text-orange-500">Planos</Link></li>
              <li><Link to={createPageUrl("Sobre")} className="text-sm transition-colors hover:text-orange-500">Sobre</Link></li>
              {/* Convite para criar conta não faz sentido para quem já tem --
                  mesma regra já aplicada na Home (seção 61), que o rodapé
                  tinha ficado de fora. Deslogado ganha também o "Entrar",
                  que faltava por completo aqui. */}
              {!isAuthenticated && (
                <>
                  <li><Link to={createPageUrl("Register")} className="text-sm transition-colors hover:text-orange-500">Criar conta</Link></li>
                  <li><Link to={createPageUrl("Login")} className="text-sm transition-colors hover:text-orange-500">Entrar</Link></li>
                </>
              )}
            </ul>
          </div>
          <div className="md:col-span-2">
            <h4 className="label-mono mb-4 text-slate-500">Categorias</h4>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-2.5">
              {FOOTER_CATEGORY_KEYS.map((key) => (
                <li key={key}>
                  <Link
                    to={createPageUrl("Suppliers") + `?category=${key}`}
                    className="text-sm transition-colors hover:text-orange-500"
                  >
                    {categoryLabel(key)}
                  </Link>
                </li>
              ))}
            </ul>
            {/* As 20 não cabem aqui (seção 215); a lista completa está no
                filtro de categoria da busca. */}
            <Link
              to={createPageUrl("Suppliers")}
              className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-slate-300 transition-colors hover:text-orange-500"
            >
              Ver todas as categorias ({CATEGORIES.length})
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
        <div className="border-t border-slate-800 pt-8 text-center text-sm text-slate-600">
          © {year} NEXAR. Todos os direitos reservados.
        </div>
      </div>
    </footer>
  );
}