import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Maximize2, X, ImageOff } from "lucide-react";

/**
 * Galeria do anúncio -- miniaturas verticais + imagem grande, no formato do
 * template que o usuário trouxe (CONTEXTO.MD/image.png).
 *
 * POR QUE SAIU DO CABEÇALHO (seção 142): o carrossel estava dentro do
 * `Cover`, uma faixa de 256px com o conteúdo da página subindo 56px por cima
 * (`-mt-14`) e o botão "Voltar" ocupando o topo. Sobravam ~150px de imagem
 * visível, espremidos, num espaço que a página tratava como enfeite. Para uma
 * galeria que o fornecedor pode encher com até 10 fotos, era pouco -- e
 * ninguém rola a página para CIMA para ver foto.
 *
 * Aqui ela é conteúdo: coluna própria, largura real, e as miniaturas dizem de
 * cara quantas imagens existem, o que a faixa não conseguia comunicar.
 *
 * SÓ RENDERIZA SE HOUVER IMAGEM. Sem galeria o componente devolve null e a
 * coluna some -- mesma regra do cartão da listagem (seção 138): o que não
 * existe some, não vira bloco vazio com uma letra dentro.
 */
export default function AdGallery({ images = [], alt = "" }) {
  const [atual, setAtual] = useState(0);
  const [ampliada, setAmpliada] = useState(false);
  const total = images.length;

  const ir = (delta) => setAtual((i) => (i + delta + total) % total);

  useEffect(() => {
    const tecla = (e) => {
      if (e.key === "Escape") return setAmpliada(false);
      if (total < 2) return;
      if (e.key === "ArrowRight") ir(1);
      if (e.key === "ArrowLeft") ir(-1);
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [total]);

  // Trava a rolagem do fundo enquanto a imagem está ampliada -- sem isto, a
  // roda do mouse rola a página ATRÁS do overlay, que é desorientador.
  useEffect(() => {
    if (!ampliada) return;
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = anterior; };
  }, [ampliada]);

  if (!total) return null;

  // No máximo 4 miniaturas; o resto vira "+N", que abre na primeira
  // escondida. Quatro e não cinco porque a coluna de miniaturas NÃO PODE ser
  // mais alta que a imagem: era isso que deixava uma faixa cinza morta
  // embaixo dela (medido: coluna 520px contra imagem 372px, seção 144).
  // Se ainda assim não couber, a coluna rola -- ver overflow-y-auto abaixo.
  const VISIVEIS = 4;
  const excedente = Math.max(0, total - VISIVEIS);
  const miniaturas = images.slice(0, VISIVEIS);

  return (
    <>
      {/* ALTURA DEFINIDA NA LINHA, não na imagem. Antes a imagem tinha
          aspect-[4/3] e a coluna de miniaturas crescia livre -- quem mandava
          na altura do bloco era a coluna, e sobrava vão cinza sob a foto.
          Agora a linha manda, a imagem preenche e as miniaturas se ajustam. */}
      <div className="flex h-[340px] gap-3 sm:h-[400px] lg:h-[460px]">
        {/* Coluna de miniaturas. Escondida no celular: lá a tela não tem
            largura para duas colunas, e os pontos abaixo da imagem grande
            fazem o mesmo papel. */}
        {total > 1 && (
          <div className="hidden w-20 shrink-0 flex-col gap-2 overflow-y-auto sm:flex">
            {miniaturas.map((img, i) => (
              <button
                key={img.id || img.url}
                type="button"
                onClick={() => setAtual(i)}
                aria-label={`Ver imagem ${i + 1}`}
                aria-current={i === atual}
                className={`aspect-square shrink-0 overflow-hidden rounded-card border-2 transition-colors ${
                  i === atual
                    ? "border-orange-500"
                    : "border-transparent opacity-70 hover:opacity-100"
                }`}
              >
                <img src={img.url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}

            {excedente > 0 && (
              <button
                type="button"
                onClick={() => setAtual(VISIVEIS)}
                className="flex aspect-square shrink-0 items-center justify-center rounded-card bg-slate-800 text-sm font-bold text-white transition-colors hover:bg-slate-700"
              >
                +{excedente}
              </button>
            )}
          </div>
        )}

        <div className="relative min-w-0 flex-1 overflow-hidden rounded-card border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-800">
          {/* aspect-[4/3] dá ao bloco uma proporção estável; object-contain
              (e não cover) garante que a IMAGEM INTEIRA apareça dentro dele.
              Com cover, qualquer foto fora de 4:3 era cortada ao meio -- e
              foto de anúncio vem em proporção qualquer: print de tela em
              16:9, foto de celular em 3:4, logo quadrado. Cortar a vitrine
              do fornecedor para caber numa moldura é decidir por ele qual
              metade importa.
              O fundo neutro preenche as bordas que sobram. */}
          <div className="relative h-full bg-slate-50 dark:bg-slate-900">
            {images.map((img, i) => (
              // Todas montadas, alternando por opacidade: trocar o src de uma
              // <img> só faria a próxima piscar em branco enquanto baixa.
              <img
                key={img.id || img.url}
                src={img.url}
                alt={i === atual ? alt : ""}
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ${
                  i === atual ? "opacity-100" : "opacity-0"
                }`}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAmpliada(true)}
            aria-label="Ampliar imagem"
            className="absolute right-3 top-3 rounded-full bg-white/85 p-2 text-slate-900 shadow-sm backdrop-blur-sm transition-colors hover:bg-white"
          >
            <Maximize2 className="h-4 w-4" />
          </button>

          {total > 1 && (
            <>
              <button
                type="button"
                onClick={() => ir(-1)}
                aria-label="Imagem anterior"
                className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-2 text-slate-900 shadow-sm backdrop-blur-sm transition-colors hover:bg-white"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => ir(1)}
                aria-label="Próxima imagem"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/85 p-2 text-slate-900 shadow-sm backdrop-blur-sm transition-colors hover:bg-white"
              >
                <ChevronRight className="h-4 w-4" />
              </button>

              <span className="tnum absolute bottom-3 right-3 rounded-full bg-slate-900/80 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                {atual + 1}/{total}
              </span>

              {/* Pontos só no celular, onde a coluna de miniaturas não cabe. */}
              <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5 sm:hidden">
                {images.map((img, i) => (
                  <button
                    key={img.id || img.url}
                    type="button"
                    onClick={() => setAtual(i)}
                    aria-label={`Ver imagem ${i + 1} de ${total}`}
                    className={`h-1.5 rounded-full transition-all ${
                      i === atual ? "w-5 bg-white" : "w-1.5 bg-white/60"
                    }`}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {ampliada && (
        // Overlay de tela cheia. `role="dialog"` + o Esc já tratado acima:
        // quem abre com teclado precisa conseguir sair sem mouse.
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Imagem ampliada"
          onClick={() => setAmpliada(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => setAmpliada(false)}
            aria-label="Fechar"
            className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>

          <img
            src={images[atual].url}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-5xl rounded-card object-contain"
          />

          {total > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); ir(-1); }}
                aria-label="Imagem anterior"
                className="absolute left-5 rounded-full bg-white/10 p-3 text-white transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); ir(1); }}
                aria-label="Próxima imagem"
                className="absolute right-5 rounded-full bg-white/10 p-3 text-white transition-colors hover:bg-white/20"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <span className="tnum absolute bottom-6 rounded-full bg-white/10 px-3 py-1 text-sm font-semibold text-white">
                {atual + 1}/{total}
              </span>
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Anúncio sem foto nenhuma. Ocupa o mesmo espaço da galeria em vez de
 * deixar a coluna vazia -- mas SEM FOTO GENÉRICA.
 *
 * Essa foi a decisão (seção 145): uma imagem de galpão qualquer preencheria
 * melhor, mas o visitante leria como foto DAQUELA empresa, e a mesma foto
 * apareceria em dezenas de anúncios diferentes. É a mesma armadilha da faixa
 * de selos que tiramos do template: enfeite que vira afirmação falsa.
 *
 * Aqui o painel ASSUME a falta e usa o espaço para dizer o que a pessoa pode
 * fazer. Para o DONO o texto muda: vira convite para adicionar.
 */
export function AdGalleryEmpty({ editUrl, isOwner = false }) {
  return (
    <div className="flex h-[340px] flex-col items-center justify-center rounded-card bg-gradient-to-br from-orange-50 via-white to-slate-50 px-6 text-center dark:from-orange-500/10 dark:via-slate-900 dark:to-slate-900 sm:h-[400px] lg:h-[460px]">
      <span className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50">
        NE<span className="text-orange-500">X</span>AR
      </span>

      <div className="mt-6 flex h-12 w-12 items-center justify-center rounded-full bg-white shadow-sm dark:bg-slate-800">
        <ImageOff className="h-5 w-5 text-orange-500" />
      </div>

      {isOwner ? (
        <>
          <p className="mt-4 max-w-xs text-sm font-semibold text-slate-700 dark:text-slate-200">
            Seu anúncio ainda não tem fotos
          </p>
          <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Anúncios com foto recebem mais contatos. Mostre seu galpão, sua equipe, seus produtos.
          </p>
          {editUrl && (
            <Link
              to={editUrl}
              className="mt-5 rounded-card bg-slate-900 px-5 py-2.5 text-[13px] font-bold text-white transition-colors hover:bg-orange-500 dark:bg-slate-100 dark:text-slate-900"
            >
              Adicionar fotos
            </Link>
          )}
        </>
      ) : (
        <>
          <p className="mt-4 max-w-xs text-sm font-semibold text-slate-700 dark:text-slate-200">
            Este fornecedor ainda não publicou fotos
          </p>
          <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Fale com ele pelo chat ou peça um orçamento para saber mais sobre o negócio.
          </p>
        </>
      )}
    </div>
  );
}
