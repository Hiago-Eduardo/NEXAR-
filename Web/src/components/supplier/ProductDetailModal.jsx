import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight, Package } from "lucide-react";
import { formatBRL } from "@/lib/plans";

/**
 * Detalhe do produto, em painel sobreposto.
 *
 * POR QUE EXISTE (seção 147): o `ProductCardMini` corta a descrição em duas
 * linhas e não levava a lugar nenhum -- não há tela de produto no projeto.
 * Então o texto cortado era informação PERDIDA, sem "ver mais" em canto
 * algum.
 *
 * E havia um buraco maior atrás disso: o card mostra "+N fotos", mas da
 * SEGUNDA imagem em diante nenhuma aparecia em lugar nenhum do site público.
 * O Premium paga por até 8 imagens por produto (PLAN_PRODUCT_IMAGE_LIMITS) e
 * só a primeira era visível -- benefício cobrado e não entregue.
 *
 * Serve as DUAS telas sem adaptação: o anúncio (ProductsSection) e a página
 * da empresa (CompanyProductsSection) passam `images` no mesmo formato, uma
 * lista de strings de URL.
 *
 * GALERIA PRÓPRIA, e não o AdGallery: aquele é feito para a coluna do
 * anúncio -- altura fixa por breakpoint, miniaturas verticais limitadas a 4.
 * Dentro de um painel sobreposto a proporção é outra e as miniaturas cabem
 * na horizontal. Reaproveitar exigiria encher o componente de condicionais
 * por contexto, que é o caminho curto para um componente que ninguém mexe.
 */
export default function ProductDetailModal({ product, images = [], onClose }) {
  const [atual, setAtual] = useState(0);
  const total = images.length;

  const ir = (delta) => setAtual((i) => (i + delta + total) % total);

  useEffect(() => {
    const tecla = (e) => {
      if (e.key === "Escape") onClose();
      if (total < 2) return;
      if (e.key === "ArrowRight") ir(1);
      if (e.key === "ArrowLeft") ir(-1);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [total, onClose]);

  // Trava a rolagem do fundo enquanto o painel está aberto.
  useEffect(() => {
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = anterior; };
  }, []);

  // createPortal: o painel nasce no <body>, fora da árvore do card. Dentro
  // dela ele herdaria `overflow-hidden` do cartão e os empilhamentos das
  // colunas -- e apareceria cortado ou atrás do conteúdo.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={product.name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-card bg-white shadow-2xl dark:bg-slate-900"
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-extrabold leading-tight text-slate-900 dark:text-slate-50">
              {product.name}
            </h2>
            {product.category && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{product.category}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-6 p-5 md:grid-cols-2">
          <div>
            <div className="relative overflow-hidden rounded-card bg-slate-50 dark:bg-slate-800">
              <div className="relative aspect-square">
                {total > 0 ? (
                  images.map((url, i) => (
                    // object-contain: mesma razão do AdGallery -- foto de
                    // produto vem em proporção qualquer, e cortar decide pelo
                    // fornecedor qual metade importa.
                    <img
                      key={url}
                      src={url}
                      alt={i === atual ? product.name : ""}
                      className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${
                        i === atual ? "opacity-100" : "opacity-0"
                      }`}
                    />
                  ))
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Package className="h-12 w-12 text-slate-200 dark:text-slate-700" />
                  </div>
                )}
              </div>

              {total > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => ir(-1)}
                    aria-label="Imagem anterior"
                    className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-2 text-slate-900 shadow-sm backdrop-blur-sm hover:bg-white"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => ir(1)}
                    aria-label="Próxima imagem"
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-2 text-slate-900 shadow-sm backdrop-blur-sm hover:bg-white"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <span className="tnum absolute bottom-3 right-3 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-semibold text-white">
                    {atual + 1}/{total}
                  </span>
                </>
              )}
            </div>

            {/* Miniaturas na HORIZONTAL aqui (no anúncio são verticais): o
                painel é largo e baixo, ao contrário da coluna. */}
            {total > 1 && (
              <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                {images.map((url, i) => (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setAtual(i)}
                    aria-label={`Ver imagem ${i + 1} de ${total}`}
                    aria-current={i === atual}
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-card border-2 transition-colors ${
                      i === atual ? "border-orange-500" : "border-transparent opacity-70 hover:opacity-100"
                    }`}
                  >
                    <img src={url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {product.price ? (
                <span className="font-display text-2xl font-black text-orange-600 dark:text-orange-400">
                  {formatBRL(product.price)}
                  <span className="text-base font-bold text-slate-400 dark:text-slate-500">
                    /{product.unit || "un"}
                  </span>
                </span>
              ) : (
                <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  Preço sob consulta
                </span>
              )}
              {product.in_stock === false && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  Indisponível
                </span>
              )}
            </div>

            {product.min_quantity > 1 && (
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Pedido mínimo: <strong className="tnum text-slate-800 dark:text-slate-100">{product.min_quantity}</strong> {product.unit || "un"}
              </p>
            )}

            {/* SEM line-clamp: é exatamente o motivo deste painel existir. */}
            {product.description && (
              <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                {product.description}
              </p>
            )}

            <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400 dark:border-slate-800 dark:text-slate-500">
              Para preço fechado, prazo e condições, fale com o fornecedor pelo chat ou peça um orçamento.
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
