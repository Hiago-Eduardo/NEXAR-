import React, { useState } from "react";
import { Upload, X, ArrowLeft, ArrowRight, Loader2, ImageIcon } from "lucide-react";
import { Label } from "@/components/ui/label";
import { api } from "@/api/client";

/**
 * Gerenciador da galeria do anúncio (o carrossel que aparece no
 * SupplierProfile).
 *
 * A PRIMEIRA IMAGEM É A CAPA. Não existe campo de capa separado: a galeria é
 * a fonte da verdade e `suppliers.cover_url` é DERIVADO dela por trigger no
 * banco (sync_supplier_cover, em supabase/supplier-gallery.sql). Por isso
 * reordenar aqui muda a capa do cartão da listagem -- e o rótulo na primeira
 * miniatura existe para que isso não seja surpresa.
 *
 * POR QUE O ESTADO É LOCAL e a gravação só acontece no save do formulário:
 * o anúncio pode nem existir ainda (modo "criar"), e nesse caso não há
 * supplier_id para pendurar as imagens. O componente devolve a lista pelo
 * onChange e quem grava é o AdEditor, depois de ter o id.
 */
export default function AdGalleryManager({ images, onChange, limit, planLabel }) {
  const [uploading, setUploading] = useState(false);
  const [erro, setErro] = useState("");

  const cheio = images.length >= limit;

  const enviar = async (e) => {
    const arquivos = Array.from(e.target.files || []);
    // Limpa o input ANTES do await: sem isto, escolher o mesmo arquivo duas
    // vezes seguidas não dispara change de novo e parece que travou.
    e.target.value = "";
    if (!arquivos.length) return;

    // Corta no limite em vez de deixar o banco recusar: o trigger
    // enforce_supplier_image_rules recusaria de qualquer jeito, mas aí o
    // fornecedor só descobriria ao salvar, depois de esperar o upload.
    const cabem = arquivos.slice(0, Math.max(0, limit - images.length));
    if (cabem.length < arquivos.length) {
      setErro(`Seu plano ${planLabel} permite ${limit} imagens neste anúncio. Enviamos as ${cabem.length} primeiras.`);
    } else {
      setErro("");
    }
    if (!cabem.length) return;

    setUploading(true);
    try {
      const enviados = [];
      for (const file of cabem) {
        const { file_url } = await api.integrations.Core.UploadFile({ file });
        enviados.push({ url: file_url });
      }
      onChange([...images, ...enviados]);
    } catch (err) {
      setErro(err?.message || "Não foi possível enviar as imagens.");
    } finally {
      setUploading(false);
    }
  };

  const remover = (i) => onChange(images.filter((_, n) => n !== i));

  const mover = (i, delta) => {
    const destino = i + delta;
    if (destino < 0 || destino >= images.length) return;
    const proxima = [...images];
    [proxima[i], proxima[destino]] = [proxima[destino], proxima[i]];
    onChange(proxima);
  };

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">
          Imagens do anúncio
        </Label>
        <span className="tnum text-xs text-slate-400 dark:text-slate-500">
          {images.length} de {limit}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        A primeira imagem é a capa — ela aparece na listagem. Arraste a ordem com as setas.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {images.map((img, i) => (
          <div
            key={img.id || img.url}
            className="group relative aspect-[4/3] overflow-hidden rounded-card border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800"
          >
            <img src={img.url} alt="" className="h-full w-full object-cover" />

            {i === 0 && (
              <span className="absolute left-2 top-2 rounded-full bg-slate-900/85 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
                Capa
              </span>
            )}

            <button
              type="button"
              onClick={() => remover(i)}
              aria-label="Remover imagem"
              className="absolute right-2 top-2 rounded-full bg-red-500 p-1 text-white hover:bg-red-600"
            >
              <X className="h-3 w-3" />
            </button>

            {/* Setas sempre visíveis, não só no hover: no celular não existe
                hover, e sem elas a ordem viraria algo que só dá para mudar no
                desktop. */}
            <div className="absolute inset-x-2 bottom-2 flex justify-between">
              <button
                type="button"
                onClick={() => mover(i, -1)}
                disabled={i === 0}
                aria-label="Mover para trás"
                className="rounded-full bg-white/90 p-1 text-slate-700 disabled:opacity-0 dark:bg-slate-900/90 dark:text-slate-200"
              >
                <ArrowLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => mover(i, 1)}
                disabled={i === images.length - 1}
                aria-label="Mover para frente"
                className="rounded-full bg-white/90 p-1 text-slate-700 disabled:opacity-0 dark:bg-slate-900/90 dark:text-slate-200"
              >
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        ))}

        {!cheio && (
          <label
            className={`flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-slate-300 text-slate-400 transition-colors hover:border-orange-400 hover:text-orange-500 dark:border-slate-700 dark:text-slate-500 ${
              uploading ? "pointer-events-none opacity-60" : ""
            }`}
          >
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Upload className="h-5 w-5" />
            )}
            <span className="text-xs font-medium">
              {uploading ? "Enviando..." : "Adicionar"}
            </span>
            <input type="file" accept="image/*" multiple className="hidden" onChange={enviar} />
          </label>
        )}
      </div>

      {images.length === 0 && !uploading && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-400 dark:text-slate-500">
          <ImageIcon className="h-3.5 w-3.5" />
          Anúncios com foto recebem mais contatos. Comece por uma imagem do seu negócio.
        </p>
      )}

      {erro && <p className="mt-3 text-xs text-red-500 dark:text-red-400">{erro}</p>}
    </div>
  );
}
