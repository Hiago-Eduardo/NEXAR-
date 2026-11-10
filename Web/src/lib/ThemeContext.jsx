import React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

// Tema global do NEXAR (claro / escuro / seguir sistema).
//
// `next-themes` já era uma dependência do projeto (usada por
// src/components/ui/sonner.jsx, que espera um <ThemeProvider> em algum
// lugar da árvore) mas nunca tinha sido conectada de verdade -- por isso
// não criamos uma segunda solução de tema, só conectamos essa. attribute="class"
// casa com o darkMode: ["class"] já configurado em tailwind.config.js, e
// storageKey="nexar-theme" é a chave pedida para persistência em localStorage.
// next-themes injeta um script síncrono que aplica a classe antes da
// primeira pintura, evitando flash de tema errado.
//
// Segue o mesmo padrão de Context/Provider já usado pelo projeto
// (src/lib/AuthContext.jsx: um arquivo em src/lib, não uma pasta nova
// src/context(s)/).
export function ThemeProvider({ children }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="nexar-theme"
    >
      {children}
    </NextThemesProvider>
  );
}

export { useTheme };
