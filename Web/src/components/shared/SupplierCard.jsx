import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Star, BadgeCheck, Sparkles } from "lucide-react";
// Nome e ícone vêm de categories.js, os mesmos da grade da Home: o card sem
// foto e sem logo mostra o ícone da categoria (seções 178 e 213).
import { categoryIcon, categoryLabel } from "@/lib/categories";

/**
 * Cartão de anúncio da listagem.
 *
 * REESCRITO na seção 138. A versão anterior era FOTO-PRIMEIRO: 176px fixos de
 * imagem no topo, e quando não havia capa -- que é a maioria dos anúncios --
 * aquele espaço virava um gradiente com a primeira letra do nome em 48px.
 * O cartão ficava alto, vazio, e ainda escrevia "Sem descrição disponível",
 * que é exibir a AUSÊNCIA de conteúdo como se fosse conteúdo.
 *
 * A regra agora é uma só, e vale para TODOS os elementos:
 *
 *     o que existe aparece; o que não existe some, sem substituto.
 *
 * ALTURA UNIFORME (corrigido na seção 139). A primeira versão deixava cada
 * cartão com a altura do próprio conteúdo, apostando em densidade. Era
 * errado, por um motivo de CSS Grid que eu deveria ter conferido antes: a
 * LINHA já tem a altura do cartão mais alto, então o cartão curto não
 * encolhe a grade -- ele só troca o espaço branco de DENTRO do cartão por um
 * buraco EMBAIXO dele. O ganho de densidade só existiria com masonry, que
 * não é o layout daqui. Resultado: dois problemas em vez de um.
 *
 * Agora os cartões esticam juntos e o espaço que sobra vai para ENTRE o
 * conteúdo e a chamada (mt-auto), não para um bloco de imagem falso com a
 * inicial em 48px -- que era o que fazia o cartão antigo parecer oco.
 *
 * POR QUE NÃO O PADRÃO FOTO-DOMINANTE que inspirou o pedido: naquele tipo de
 * site a foto É o produto e a decisão é visual. Aqui a decisão é B2B --
 * categoria, local, pedido mínimo, reputação. A foto de uma transportadora é
 * um galpão genérico. Foto-dominante amplificaria o sinal mais fraco e
 * esconderia os mais fortes.
 *
 * `isNew` existe porque a Home (FeaturedSuppliers.jsx) mantinha uma cópia
 * deste componente só para ter o selo "Novo"; com a prop, a cópia morreu
 * (seção 75).
 */
// Os campos do banco vêm como "" e não null quando o fornecedor não
// preencheu -- conferido nos dados reais (1 de 3 anúncios tem min_order).
// `!!valor` trataria "" como ausente por acaso; este helper deixa a intenção
// explícita e cobre o espaço em branco digitado sem querer.
const preenchido = (v) => typeof v === "string" ? v.trim().length > 0 : v != null;

export default function SupplierCard({ supplier, verified = false, index = null, isNew = false }) {
  const adUrl = createPageUrl("SupplierProfile") + `?id=${supplier.id}`;

  const temCapa = preenchido(supplier.cover_url);
  const temLogo = preenchido(supplier.logo_url);
  const IconeCategoria = categoryIcon(supplier.category);
  const temDescricao = preenchido(supplier.description);
  const temPedidoMinimo = preenchido(supplier.min_order);
  const temNota = Number(supplier.rating) > 0;
  const temNumeros = temPedidoMinimo || temNota;

  const categoria = categoryLabel(supplier.category);
  const local = preenchido(supplier.location) ? supplier.location : null;

  return (
    // O cartão INTEIRO é o alvo de clique. A versão anterior tinha dois links
    // no rodapé ("Ver anúncio" e "Empresa") dividindo a intenção e o alvo. O
    // caminho para a empresa não sumiu do produto -- ele continua dentro do
    // anúncio, que é onde faz sentido decidir olhar a empresa toda.
    <Link to={adUrl} className="listing-card group flex h-full flex-col p-5">
      {/* IMAGEM EM 2:1 (seção 178). Era uma faixa de 112px -- decidida na
          seção 138, quando quase nenhum anúncio tinha foto. Com a galeria
          (seção 139) as capas passaram a existir, e a faixa cortava fotos
          4:3 num recorte de ~4:1. 2:1 (~225px num cartão de 450) mostra a
          foto sem empurrar pedido mínimo e nota para fora da vista.

          SEM FOTO, o espaço continua lá -- com a foto maior, um cartão sem
          ela ficaria bem mais baixo que os vizinhos. Mostra o LOGO da
          empresa, ou o ícone da categoria, sobre fundo neutro. Não é o
          antigo "letra gigante em gradiente": é a marca real ou um ícone
          que diz o ramo. */}
      <div className="-mx-5 -mt-5 mb-4 aspect-[2/1] overflow-hidden bg-slate-100 dark:bg-slate-800">
        {temCapa ? (
          <img
            src={supplier.cover_url}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            loading="lazy"
          />
        ) : temLogo ? (
          <div className="flex h-full w-full items-center justify-center p-6">
            <img
              src={supplier.logo_url}
              alt=""
              className="max-h-24 max-w-[60%] rounded-card object-contain"
              loading="lazy"
            />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <IconeCategoria className="h-12 w-12 text-slate-300 dark:text-slate-600" aria-hidden="true" />
          </div>
        )}
      </div>

      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="line-clamp-2 font-display text-lg font-extrabold leading-tight text-slate-900 transition-colors group-hover:text-orange-600 dark:text-slate-50 dark:group-hover:text-orange-400">
            {supplier.business_name}
          </h3>
          {/* Categoria e local numa linha só, em texto simples. Eram duas
              peças separadas (pílula laranja + ícone de mapa) competindo com
              o nome; juntas viram contexto, que é o papel delas. */}
          <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400">
            {categoria}
            {local && <span className="text-slate-300 dark:text-slate-600"> · </span>}
            {local}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {verified && (
            <span className="flex items-center gap-1 rounded-full bg-orange-500 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm">
              <BadgeCheck className="h-3.5 w-3.5" />
              Verificado
            </span>
          )}
          {isNew && (
            <span className="flex items-center gap-1 rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white dark:bg-white dark:text-slate-900">
              <Sparkles className="h-3 w-3" />
              Novo
            </span>
          )}
        </div>
      </div>

      {temDescricao && (
        <p className="mb-4 line-clamp-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {supplier.description}
        </p>
      )}

      {/* OS NÚMEROS QUE DECIDEM UMA COMPRA B2B. O pedido mínimo não aparecia
          em lugar nenhum do cartão antigo -- apesar de ser filtro na própria
          tela de listagem. A linha inteira some quando não há nem pedido
          mínimo nem nota, em vez de mostrar dois trações. */}
      {temNumeros && (
        <div className="mb-4 flex gap-7 border-y border-slate-100 py-3 dark:border-slate-800">
          {temPedidoMinimo && (
            <div>
              <p className="label-mono text-[10px] text-slate-400 dark:text-slate-500">Pedido mínimo</p>
              <p className="tnum mt-0.5 text-sm font-bold text-slate-900 dark:text-slate-100">
                {supplier.min_order}
              </p>
            </div>
          )}
          {temNota && (
            <div>
              <p className="label-mono text-[10px] text-slate-400 dark:text-slate-500">Avaliação</p>
              <p className="tnum mt-0.5 flex items-center gap-1 text-sm font-bold text-slate-900 dark:text-slate-100">
                <Star className="h-3.5 w-3.5 fill-orange-500 text-orange-500" />
                {Number(supplier.rating).toFixed(1)}
                {supplier.total_reviews > 0 && (
                  <span className="font-normal text-slate-400 dark:text-slate-500">
                    ({supplier.total_reviews})
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      )}

      {/* mt-auto prende a chamada no rodapé. É ele que faz o espaço que
          sobra num cartão pouco preenchido ficar ACIMA do botão, e não
          espalhado no meio do conteúdo -- e alinha os botões de toda a
          linha, que é o que dá a sensação de grade organizada. */}
      <span className="mt-auto block rounded-card bg-slate-900 py-2.5 text-center text-[13px] font-bold text-white transition-colors group-hover:bg-orange-500 dark:bg-slate-100 dark:text-slate-900 dark:group-hover:bg-orange-500 dark:group-hover:text-white">
        Ver anúncio
      </span>

      {/* `index` continua na assinatura porque Suppliers.jsx passa a prop, mas
          o número do catálogo saiu do visual: era decoração sem informação,
          e o pedido desta rodada foi tirar cromo. Remover a prop exigiria
          mexer na chamada -- fica para quando alguém tocar naquele arquivo. */}
      {typeof index === "number" && null}
    </Link>
  );
}
