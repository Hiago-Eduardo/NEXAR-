import React, { useState } from "react";
import { Package, Images } from "lucide-react";
import { formatBRL } from "@/lib/plans";
import ProductDetailModal from "./ProductDetailModal";

/**
 * Card de produto, reutilizado no catálogo de um único anúncio
 * (ProductsSection.jsx), no catálogo agregado da empresa
 * (CompanyProductsSection.jsx) e na tela de gestão (Catalogo.jsx) -- mesma
 * aparência, fontes de dado diferentes.
 *
 * AGORA É UMA PRÉVIA CLICÁVEL (seção 147). Antes era um beco: a descrição
 * era cortada em duas linhas e o card não levava a lugar nenhum, então o
 * texto cortado sumia de vez -- não existe tela de produto no projeto. E o
 * "+N fotos" anunciava imagens que ninguém conseguia ver.
 *
 * Com o painel de detalhe, cortar passa a ser legítimo: o card RESUME e o
 * painel mostra tudo.
 *
 * `interativo` existe para o Catalogo.jsx, onde o card já vive dentro de um
 * item com as próprias ações (editar/excluir) -- lá abrir um painel ao
 * clicar brigaria com a edição.
 */
export default function ProductCardMini({ product, images = [], interativo = true, className = "" }) {
  const [aberto, setAberto] = useState(false);
  const coverImage = images[0];
  const extras = Math.max(0, images.length - 1);

  const conteudo = (
    <>
      <div className="relative h-36 shrink-0 overflow-hidden bg-slate-50 dark:bg-slate-800/60">
        {coverImage ? (
          <img
            src={coverImage}
            alt={product.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-10 w-10 text-slate-200 dark:text-slate-700" />
          </div>
        )}

        {/* O contador agora é PROMESSA CUMPRIDA: clicar abre as outras. Antes
            informava um número que não levava a nada. */}
        {extras > 0 && (
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Images className="h-3 w-3" />
            +{extras}
          </span>
        )}

        {product.in_stock === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <span className="rounded-full bg-black/60 px-2 py-1 text-xs font-medium text-white">Indisponível</span>
          </div>
        )}
      </div>

      {/* Corpo em coluna com o preço em mt-auto: quando o card estica para a
          altura da linha, o espaço sobra ACIMA do preço, e os preços de cards
          vizinhos ficam na mesma altura em vez de subir com o texto curto. */}
      <div className="flex flex-1 flex-col p-3">
        {/* Nome em DUAS linhas (era uma): num card de meia coluna,
            "Frete fracionado (LTL)" já estourava e virava reticências. */}
        <h4 className="line-clamp-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {product.name}
        </h4>

        {/* Descrição com mais contraste: era slate-400, o mesmo tom de
            legenda desbotada, para um texto que é o resumo do produto. */}
        {product.description && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {product.description}
          </p>
        )}

        {/* Preço e "Mín:" EMPILHADOS, não lado a lado. Com
            "R$ 1.890,00/viagem" os dois brigavam pela mesma linha e o
            mínimo era o que quebrava. */}
        <div className="mt-auto pt-2">
          {product.price ? (
            <span className="block text-sm font-bold text-orange-600 dark:text-orange-400">
              {formatBRL(product.price)}
              <span className="font-semibold text-slate-400 dark:text-slate-500">/{product.unit || "un"}</span>
            </span>
          ) : (
            <span className="block text-xs text-slate-400 dark:text-slate-500">Consulte preço</span>
          )}
          {product.min_quantity > 1 && (
            <span className="tnum mt-0.5 block text-xs text-slate-400 dark:text-slate-500">
              Mín: {product.min_quantity} {product.unit || "un"}
            </span>
          )}
        </div>
      </div>
    </>
  );

  const classe =
    // SEM h-full: num item de grade que tem o card E botoes abaixo (a tela
    // de Catalogo), o h-full fazia o card ocupar a altura inteira do item e
    // empurrava os botoes para FORA dele -- o card da linha seguinte cobria
    // Editar/Excluir da anterior (secao 148). Itens de grade ja esticam
    // sozinhos por padrao, entao o h-full nunca foi necessario.
    "group flex flex-col overflow-hidden rounded-card border border-slate-200 text-left transition-all hover:border-orange-300 hover:shadow-md dark:border-slate-800 dark:hover:border-orange-500/40";

  if (!interativo) {
    return <div className={`${classe} ${className}`}>{conteudo}</div>;
  }

  return (
    <>
      {/* <button> e não <div onClick>: o card vira alvo de teclado e leitor de
          tela de graça, com foco visível e Enter/Espaço funcionando. */}
      <button type="button" onClick={() => setAberto(true)} className={`${classe} w-full ${className}`}>
        {conteudo}
      </button>

      {aberto && (
        <ProductDetailModal product={product} images={images} onClose={() => setAberto(false)} />
      )}
    </>
  );
}
