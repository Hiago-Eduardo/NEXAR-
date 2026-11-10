import React, { useState, useEffect } from "react";
import { api } from "@/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft, Loader2, CheckCircle, Store, X, ImagePlus, Save, Package, Check, Search,
  Info, Lock, RefreshCw
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { PLAN_LABELS, getPlanAdLimit, getPlanAdImageLimit, formatBRL } from "@/lib/plans";
import { getItemState, ITEM_STATE_LABELS } from "@/lib/itemStatus";
import AdGalleryManager from "@/components/supplier/AdGalleryManager";
import { getSubscriptionState, hasUsableBenefits } from "@/lib/subscription";
import { useAuth } from "@/lib/AuthContext";
import { CATEGORIES } from "@/lib/categories";
import CategoryHint from "@/components/shared/CategoryHint";
import { isValidCNPJ, formatCNPJ } from "@/lib/cnpj";

// Destaques do anúncio (`suppliers.tags`): aparecem como checklist na página
// do anúncio e entram na busca da listagem. Limites só de interface, para o
// checklist continuar legível -- o banco aceita qualquer array.
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 60;

// Os triggers do banco levantam exceção com prefixo (código P0001), não
// 42501 -- e a mensagem crua ("PLAN_LIMIT: voce atingiu...", sem acento)
// chegava à tela (auditoria, seção 160).
function mensagemDeErroAoSalvar(error) {
  const msg = error?.message || "";
  if (/PLAN_REQUIRED/.test(msg)) return "Você precisa de um plano ativo para publicar este anúncio.";
  if (/PLAN_LIMIT/.test(msg) && /imagens/.test(msg)) return "Você atingiu o limite de imagens do anúncio no seu plano. Remova alguma imagem ou mude de plano.";
  if (/PLAN_LIMIT/.test(msg)) return "Você atingiu o limite de anúncios do seu plano. Mude de plano para publicar mais anúncios.";
  if (error?.code === "42501" || /row-level security/i.test(msg)) {
    return "Você precisa de um plano ativo, dentro do limite de anúncios, para publicar este anúncio.";
  }
  return msg || "Não foi possível salvar o anúncio.";
}

function ImageUploadField({ label, value, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [erro, setErro] = useState("");
  const handleFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setErro("");
    // Sem try/finally, uma falha no upload deixava o spinner girando para
    // sempre e o campo travado (disabled enquanto uploading).
    try {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      onChange(file_url);
    } catch (err) {
      setErro(err?.message || "Não foi possível enviar a imagem.");
    } finally {
      setUploading(false);
    }
  };
  return (
    <div>
      <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">{label}</Label>
      <div className="mt-1.5">
        {value ? (
          <div className="relative inline-block w-full">
            <img src={value} alt="" className="h-32 w-full object-cover rounded-card border border-slate-200 dark:border-slate-700" />
            <button type="button" onClick={() => onChange("")} className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 hover:bg-red-600">
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <label className="flex flex-col items-center justify-center h-28 rounded-card border-2 border-dashed border-slate-200 dark:border-slate-700 cursor-pointer hover:border-orange-400 hover:bg-orange-50/30 dark:hover:bg-orange-500/10 transition-all">
            {uploading ? <Loader2 className="w-6 h-6 text-orange-500 animate-spin" /> : (
              <><ImagePlus className="w-7 h-7 text-slate-300 dark:text-slate-600 mb-2" /><span className="text-xs text-slate-400 dark:text-slate-500">Clique para enviar imagem</span></>
            )}
            <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
          </label>
        )}
      </div>
      {erro && <p className="mt-2 text-xs text-red-500 dark:text-red-400">{erro}</p>}
    </div>
  );
}

// Item selecionável do catálogo -- desde a introdução do catálogo por
// empresa (ver CONTEXTO.MD/Resumo.md seções 66-67), o anúncio não cria mais
// produtos direto: escolhe quais produtos já cadastrados no catálogo (tela
// Catalogo.jsx) aparecem neste anúncio específico.
// Dados do PERFIL (Minha Conta) que valem para o anúncio (seção 173).
// Cópia EDITÁVEL: uma filial em outra cidade ou uma linha com outro nome
// precisa poder divergir. O CNPJ não entra aqui -- ele é da empresa e vem
// sempre do perfil (ver `profileCnpj`). Campo vazio no perfil não apaga o
// que já está no formulário.
function camposDoPerfil(profile) {
  if (!profile) return {};
  const cidade = (profile.city || "").trim();
  const uf = (profile.state || "").trim();
  const campos = {
    business_name: (profile.company_name || "").trim(),
    description: (profile.company_description || "").trim(),
    // Segmento antigo digitado à mão não é categoria válida: fica de fora.
    category: CATEGORIES.some((c) => c.key === profile.segment) ? profile.segment : "",
    location: cidade && uf ? `${cidade}, ${uf}` : cidade,
    phone: (profile.phone || "").trim(),
    logo_url: profile.avatar_url || "",
  };
  return Object.fromEntries(Object.entries(campos).filter(([, v]) => v));
}

// A busca só aparece a partir deste tamanho de catálogo: com poucos
// produtos, um campo a mais é ruído (seção 172).
const PRODUCT_SEARCH_MIN = 8;

// Busca sem acento e sem caixa: "acucar" acha "Açúcar".
const normalizar = (texto) =>
  (texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function CatalogProductPickerItem({ product, imageUrl, selected, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      // min-w-0 w-full: item de grade não encolhe abaixo do conteúdo, e o
      // nome longo empurrava o item para fora da tela no celular (seção 172).
      className={`flex w-full min-w-0 items-center gap-3 p-3 rounded-card border text-left transition-colors ${
        selected
          ? "border-orange-400 bg-orange-50 dark:border-orange-500/50 dark:bg-orange-500/10"
          : "border-slate-100 dark:border-slate-800 hover:border-slate-200 dark:hover:border-slate-700"
      }`}
    >
      <div className="w-11 h-11 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <Package className="w-5 h-5 text-slate-300 dark:text-slate-600" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{product.name}</p>
        <p className="text-xs text-slate-400 dark:text-slate-500 truncate">
          {product.price ? `${formatBRL(product.price)}/${product.unit || "un"}` : "Consulte preço"}
        </p>
        {/* Marcar um produto fora do site no anúncio não o publica: o
            anúncio só mostra produtos ativos. Avisar evita "marquei e não
            aparece". */}
        {getItemState(product) !== "active" && (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400 truncate">
            {ITEM_STATE_LABELS[getItemState(product)]}: não aparece no anúncio
          </p>
        )}
      </div>
      <div className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
        selected ? "bg-orange-500 border-orange-500" : "border-slate-300 dark:border-slate-600"
      }`}>
        {selected && <Check className="w-3.5 h-3.5 text-white" />}
      </div>
    </button>
  );
}

export default function AdEditor() {
  const urlParams = new URLSearchParams(window.location.search);
  const supplierId = urlParams.get("id"); // se houver id, é edição
  const isEdit = !!supplierId;
  const selectedPlan = urlParams.get("plan") || "basico";

  const { user, isLoadingAuth, authChecked } = useAuth();
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // O formulário só aparece depois de carregar. Na edição ele aparecia vazio
  // e era preenchido de repente, e o catálogo dizia "você ainda não tem
  // produtos" enquanto carregava.
  const [loading, setLoading] = useState(true);
  // Id do anúncio criado NESTA tela. Se o anúncio foi criado mas a gravação
  // seguinte (galeria, produtos) falhou, o próximo clique em salvar ATUALIZA
  // este anúncio em vez de criar um segundo.
  const [createdId, setCreatedId] = useState(null);
  const [tagDraft, setTagDraft] = useState("");
  const [catalogProducts, setCatalogProducts] = useState([]);
  const [catalogImages, setCatalogImages] = useState({}); // { [product_id]: url }
  const [selectedProductIds, setSelectedProductIds] = useState(new Set());
  const [productSearch, setProductSearch] = useState("");
  const [profile, setProfile] = useState(null);
  // Quais campos vieram do perfil ao criar -- para o aviso no topo.
  const [prefilledFields, setPrefilledFields] = useState([]);
  const [existingLinks, setExistingLinks] = useState([]); // [{ id, product_id }] (só em edição)
  // Galeria do anúncio. Estado LOCAL: no modo "criar" o anúncio ainda não
  // existe, então não há supplier_id para pendurar as imagens -- a gravação
  // acontece no save, depois de o anúncio ter id.
  const [gallery, setGallery] = useState([]);       // [{ id?, url }] na ordem exibida
  const [galleryLoaded, setGalleryLoaded] = useState([]); // o que já estava no banco
  const [form, setForm] = useState({
    business_name: "", cnpj: "", description: "", category: "", location: "",
    phone: "", email: "", website: "", min_order: "", delivery_info: "",
    cover_url: "", logo_url: "", plan: selectedPlan, tags: []
  });

  const queryClient = useQueryClient();

  useEffect(() => {
    if (authChecked && !user) {
      // Com a query: quem estava editando (?id=) volta para o MESMO anúncio,
      // não para a tela de criar.
      api.auth.redirectToLogin(window.location.pathname + window.location.search);
    }
  }, [authChecked, user]);

  useEffect(() => {
    if (isLoadingAuth || !user) return;
    let cancelled = false;

    async function loadEditor() {
      try {
        // Perfil da conta (Minha Conta): preenche o anúncio novo e dá o CNPJ
        // (seção 173). Falhar aqui não impede o editor -- os campos só
        // deixam de vir preenchidos.
        let myProfile = null;
        try {
          let profiles = await api.entities.UserProfile.filter({ created_by: user.id });
          if (!profiles.length && user.email) {
            profiles = await api.entities.UserProfile.filter({ created_by: user.email });
          }
          myProfile = profiles[0] || null;
        } catch (profileError) {
          console.warn("Não foi possível carregar o perfil da empresa:", profileError);
        }
        if (cancelled) return;
        setProfile(myProfile);

        if (!isEdit) {
          let subscription = null;
          try {
            subscription = await api.subscriptions.getCurrent();
          } catch (subscriptionError) {
            console.warn("Não foi possível carregar a assinatura do fornecedor:", subscriptionError);
          }

          // Bloqueio de acesso direto à criação de anúncio: sem plano ativo (ou expirado),
          // não entra no editor. A validade real é sempre conferida de novo no backend
          // (trigger em suppliers), isso aqui é só para não deixar o usuário preencher o
          // formulário à toa.
          if (!hasUsableBenefits(subscription)) {
            if (cancelled) return;
            const expired = getSubscriptionState(subscription) === "expired";
            setLoadError(
              expired
                ? "Seu plano expirou. Redirecionando para os planos..."
                : "Você precisa de um plano ativo para criar anúncios. Redirecionando para os planos..."
            );
            window.location.href = `${createPageUrl("Planos")}?onboarding=1`;
            return;
          }

          const currentActivePlan = subscription.plan_id;

          let mySuppliers = [];
          try {
            mySuppliers = await api.entities.Supplier.filter({ created_by: user.email });
          } catch (supplierError) {
            console.warn("Não foi possível verificar seus anúncios existentes:", supplierError);
          }
          const activeAdsCount = mySuppliers.filter((s) => (s.status || "active") === "active").length;
          if (activeAdsCount >= getPlanAdLimit(currentActivePlan)) {
            if (cancelled) return;
            setLoadError(
              `Você atingiu o limite de anúncios ativos do plano ${PLAN_LABELS[currentActivePlan]}. Mude de plano para criar mais anúncios.`
            );
            window.location.href = `${createPageUrl("Planos")}?manage=1`;
            return;
          }

          // Só na CRIAÇÃO: na edição nada do anúncio é sobrescrito sem a
          // pessoa pedir (botão "Usar dados do perfil").
          const doPerfil = camposDoPerfil(myProfile);
          setPrefilledFields(Object.keys(doPerfil));
          setForm((currentForm) => ({ ...currentForm, ...doPerfil, cnpj: myProfile?.cnpj || "", plan: currentActivePlan }));
        }

        // Catálogo do fornecedor -- carregado sempre (criação ou edição), pra
        // o seletor de produtos do anúncio. Ver CONTEXTO.MD/Resumo.md seções 66-67.
        try {
          const myProducts = await api.entities.Product.filter({ created_by: user.email }, "-created_date");
          if (cancelled) return;
          setCatalogProducts(myProducts);
          const imagesByProduct = await Promise.all(
            myProducts.map((p) => api.entities.ProductImage.filter({ product_id: p.id }, "position", 1))
          );
          if (cancelled) return;
          setCatalogImages(
            Object.fromEntries(myProducts.map((p, index) => [p.id, imagesByProduct[index][0]?.url]))
          );
        } catch (catalogError) {
          console.warn("Não foi possível carregar o catálogo de produtos:", catalogError);
        }

        if (isEdit && supplierId) {
          const [suppliers, links] = await Promise.all([
            api.entities.Supplier.filter({ id: supplierId }),
            api.entities.SupplierProduct.filter({ supplier_id: supplierId }),
          ]);
          if (cancelled) return;
          if (!suppliers[0]) {
            setLoadError("Anúncio não encontrado.");
            return;
          }
          // O filtro por id acha anúncio de QUALQUER empresa (a leitura é
          // pública). Sem esta checagem o formulário abria preenchido com o
          // anúncio alheio; o save seria barrado pela RLS, mas só no fim.
          if (suppliers[0].created_by && suppliers[0].created_by !== user.id) {
            setLoadError("Este anúncio pertence a outra empresa e não pode ser editado por você.");
            return;
          }
          if (suppliers[0]) {
            // suppliers.plan é uma cópia denormalizada, gravada só na criação/última
            // edição -- sem isto, editar um anúncio antigo reenviaria o plano de
            // volta pro valor congelado na linha, mesmo que o fornecedor já tenha
            // mudado de plano depois (ver PLAN_REQUIRED/CLAUDE.md). Recalcula a
            // partir da assinatura real antes de popular o form.
            let currentPlan = suppliers[0].plan;
            try {
              const subscription = await api.subscriptions.getCurrent();
              if (subscription?.plan_id) currentPlan = subscription.plan_id;
            } catch (subscriptionError) {
              console.warn("Não foi possível confirmar o plano atual do fornecedor:", subscriptionError);
            }
            if (cancelled) return;
            setForm({ ...suppliers[0], plan: currentPlan, tags: suppliers[0].tags || [] });

            const imagens = await api.entities.SupplierImage.filter(
              { supplier_id: suppliers[0].id }, "position"
            );
            if (cancelled) return;
            setGallery(imagens.map((i) => ({ id: i.id, url: i.url })));
            setGalleryLoaded(imagens);
          }
          setExistingLinks(links);
          setSelectedProductIds(new Set(links.map((l) => l.product_id)));
        }
      } catch (error) {
        if (cancelled) return;
        console.error("Ad editor load failed:", error);
        // 22P02: o ?id= da URL não é um uuid (link quebrado ou editado à mão).
        // A mensagem do Postgres ("invalid input syntax for type uuid") não
        // diz nada para quem está na tela.
        setLoadError(
          error?.code === "22P02"
            ? "Anúncio não encontrado."
            : error.message || "Não foi possível carregar o editor."
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadEditor();
    return () => {
      cancelled = true;
    };
  }, [isEdit, supplierId, user, isLoadingAuth]);

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <p role="alert" className="text-sm text-red-600">{loadError}</p>
      </div>
    );
  }

  const handleChange = (field, value) => setForm((p) => ({ ...p, [field]: value }));

  // CNPJ é da EMPRESA: vem sempre do perfil e fica travado no anúncio. Só
  // quando o perfil não tem CNPJ (conta antiga) o campo continua editável,
  // para não impedir a publicação.
  const profileCnpj = (profile?.cnpj || "").trim();
  const dadosDoPerfil = camposDoPerfil(profile);
  const perfilIncompleto = !profileCnpj || Object.keys(dadosDoPerfil).length < 6;
  const usarDadosDoPerfil = () => setForm((p) => ({ ...p, ...dadosDoPerfil }));

  const addTag = () => {
    const tag = tagDraft.trim().slice(0, MAX_TAG_LENGTH);
    if (!tag) return;
    setForm((p) => {
      const atuais = p.tags || [];
      if (atuais.length >= MAX_TAGS) return p;
      if (atuais.some((t) => t.toLowerCase() === tag.toLowerCase())) return p;
      return { ...p, tags: [...atuais, tag] };
    });
    setTagDraft("");
  };

  const removeTag = (tag) => setForm((p) => ({ ...p, tags: (p.tags || []).filter((t) => t !== tag) }));

  const toggleProductSelection = (productId) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  // O que o seletor mostra agora (com a busca aplicada). "Selecionar todos"
  // age sobre ESTA lista: buscando "caixa", marca só as caixas.
  const visibleCatalog = productSearch.trim()
    ? catalogProducts.filter((p) => normalizar(p.name).includes(normalizar(productSearch.trim())))
    : catalogProducts;
  const allVisibleSelected = visibleCatalog.length > 0 && visibleCatalog.every((p) => selectedProductIds.has(p.id));

  const selectAllVisible = () => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      visibleCatalog.forEach((p) => next.add(p.id));
      return next;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaveError("");
    // Só o campo editável (perfil sem CNPJ) é validado aqui: o CNPJ que vem
    // do perfil já foi validado em Minha Conta, e um CNPJ antigo inválido no
    // perfil não pode travar a publicação (o banco aceita o do perfil).
    if (!profileCnpj && !isValidCNPJ(form.cnpj)) {
      setSaveError("CNPJ inválido. Confira os números: os dois últimos dígitos não batem com o resto.");
      return;
    }
    setSaving(true);

    // Local e não o estado `createdId`: dentro deste handler o estado ainda
    // tem o valor de antes do clique.
    let anuncioJaExiste = !!(supplierId || createdId);
    try {
      const supplierData = {
        business_name: form.business_name,
        cnpj: profileCnpj || form.cnpj,
        description: form.description,
        category: form.category,
        location: form.location,
        phone: form.phone,
        email: form.email,
        website: form.website,
        min_order: form.min_order,
        delivery_info: form.delivery_info,
        cover_url: form.cover_url,
        logo_url: form.logo_url,
        plan: form.plan,
        tags: form.tags || [],
      };

      let supplier;
      const idExistente = supplierId || createdId;
      if (idExistente) {
        supplier = await api.entities.Supplier.update(idExistente, supplierData);
      } else {
        supplier = await api.entities.Supplier.create(supplierData);
        setCreatedId(supplier.id);
        anuncioJaExiste = true;
      }

      // Sincroniza quais produtos do catálogo aparecem neste anúncio --
      // diferença entre o que já estava vinculado (existingLinks) e o que
      // está selecionado agora, em vez de apagar/recriar tudo.
      const existingProductIds = new Set(existingLinks.map((l) => l.product_id));
      const toAdd = [...selectedProductIds].filter((id) => !existingProductIds.has(id));
      const toRemove = existingLinks.filter((l) => !selectedProductIds.has(l.product_id));
      // allSettled + atualizar existingLinks com o que DEU CERTO: se a
      // gravação falhar mais adiante e a pessoa salvar de novo, o diff parte
      // do estado real. Antes, a nova tentativa recriava os vínculos já
      // gravados e batia no unique (supplier_id, product_id) -- o anúncio
      // não salvava mais (seção 160).
      const [adicionados, removidos] = await Promise.all([
        Promise.allSettled(toAdd.map((productId) => api.entities.SupplierProduct.create({ supplier_id: supplier.id, product_id: productId }))),
        Promise.allSettled(toRemove.map((link) => api.entities.SupplierProduct.delete(link.id))),
      ]);
      const idsRemovidos = new Set(toRemove.filter((_, i) => removidos[i].status === "fulfilled").map((l) => l.id));
      setExistingLinks([
        ...existingLinks.filter((l) => !idsRemovidos.has(l.id)),
        ...adicionados.filter((r) => r.status === "fulfilled").map((r) => r.value),
      ]);
      const falhaVinculo = [...adicionados, ...removidos].find((r) => r.status === "rejected");
      if (falhaVinculo) throw falhaVinculo.reason;

      // GALERIA: apaga o que saiu e recria o que ficou, em ordem.
      //
      // Recriar em vez de fazer diff fino é deliberado: `position` muda em
      // cascata quando a pessoa reordena, então um diff teria de atualizar
      // quase todas as linhas de qualquer jeito. O trigger sync_supplier_cover
      // acerta o cover_url do anúncio sozinho a cada mudança.
      const idsQueFicaram = new Set(gallery.map((g) => g.id).filter(Boolean));
      await Promise.all(
        galleryLoaded
          .filter((img) => !idsQueFicaram.has(img.id))
          .map((img) => api.entities.SupplierImage.delete(img.id))
      );
      // Em série, não em Promise.all: o trigger de limite por plano conta as
      // linhas existentes, e inserções simultâneas poderiam passar do limite
      // porque todas leriam a mesma contagem antes de qualquer commit.
      const gravadas = [];
      try {
        for (let i = 0; i < gallery.length; i += 1) {
          const img = gallery[i];
          if (img.id) {
            await api.entities.SupplierImage.update(img.id, { position: i });
            gravadas.push(img);
          } else {
            const nova = await api.entities.SupplierImage.create({
              supplier_id: supplier.id, url: img.url, position: i,
            });
            gravadas.push({ id: nova.id, url: nova.url });
          }
        }
      } finally {
        // Se uma imagem falhar no meio, as já gravadas ganham id e passam a
        // contar como "do banco": a nova tentativa não as grava de novo nem
        // deixa de apagá-las se a pessoa removê-las (seção 160).
        const atualizada = [...gravadas, ...gallery.slice(gravadas.length)];
        setGallery(atualizada);
        setGalleryLoaded(atualizada.filter((g) => g.id));
      }

      queryClient.invalidateQueries({ queryKey: ["my-suppliers"] });

      setSaved(true);
    } catch (error) {
      console.error("Ad save failed:", error);
      // Criação que passou do anúncio mas falhou depois: dizer que o anúncio
      // EXISTE, senão a pessoa acha que perdeu tudo.
      setSaveError(
        !isEdit && anuncioJaExiste
          ? `O anúncio foi criado, mas nem tudo foi salvo. ${mensagemDeErroAoSalvar(error)} Salve de novo para concluir.`
          : mensagemDeErroAoSalvar(error)
      );
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center px-6">
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center max-w-md">
          {/* Verde de propósito: confirmação semântica real (seção 71). */}
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10">
            <CheckCircle className="w-10 h-10 text-emerald-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50 mb-3">
            {isEdit ? "Anúncio atualizado!" : "Anúncio criado!"}
          </h2>
          <p className="text-slate-500 dark:text-slate-400 mb-8">Seu anúncio já está visível na plataforma.</p>
          <div className="flex gap-3 justify-center">
            <Link to={createPageUrl("Dashboard")}>
              <Button variant="outline" className="rounded-card">Ir ao Dashboard</Button>
            </Link>
            <Link to={createPageUrl("Suppliers")}>
              <Button className="rounded-card bg-orange-500 hover:bg-orange-600 text-white">Ver Fornecedores</Button>
            </Link>
          </div>
        </motion.div>
      </div>
    );
  }

  if (isLoadingAuth || !user || loading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-orange-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 sticky top-0 z-40">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center gap-4">
          <Link to={createPageUrl("Dashboard")}>
            <Button variant="ghost" size="sm" className="text-slate-500 dark:text-slate-400 gap-1.5">
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Button>
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="font-display font-extrabold text-slate-900 dark:text-slate-50">{isEdit ? "Editar Anúncio" : "Criar Anúncio"}</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8">
        <form onSubmit={handleSubmit} className="space-y-6">

          {/* Imagens */}
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardContent className="p-6 space-y-5">
              <h2 className="font-semibold text-slate-800 dark:text-slate-100">Imagens</h2>
              {/* A capa saiu daqui: ela é a PRIMEIRA imagem da galeria, e
                  suppliers.cover_url é mantido pelo trigger do banco. Ter os
                  dois seria dois lugares para gerenciar a mesma coisa. */}
              <AdGalleryManager
                images={gallery}
                onChange={setGallery}
                limit={getPlanAdImageLimit(form.plan)}
                planLabel={PLAN_LABELS[form.plan] || form.plan}
              />
              <div className="max-w-xs border-t border-slate-100 pt-5 dark:border-slate-800">
                {/* O logo continua separado e no mesmo lugar: é a MARCA da
                    empresa, exibida ao lado do nome no anúncio -- não é foto
                    do negócio. */}
                <ImageUploadField label="Logo da Empresa" value={form.logo_url} onChange={(url) => handleChange("logo_url", url)} />
              </div>
            </CardContent>
          </Card>

          {/* Informações da empresa */}
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardContent className="p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-semibold text-slate-800 dark:text-slate-100">Informações da Empresa</h2>
                {/* Na edição, trazer o perfil é uma ação explícita: o anúncio
                    pode ter sido feito diferente de propósito. Só muda o
                    formulário -- nada é gravado antes de Salvar. */}
                {isEdit && Object.keys(dadosDoPerfil).length > 0 && (
                  <Button type="button" variant="outline" size="sm" onClick={usarDadosDoPerfil} className="rounded-card gap-1.5">
                    <RefreshCw className="w-3.5 h-3.5" /> Usar dados do perfil
                  </Button>
                )}
              </div>

              {!isEdit && (prefilledFields.length > 0 || perfilIncompleto) && (
                <div className="flex gap-2.5 rounded-card border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                  <p>
                    {prefilledFields.length > 0 && "Preenchemos com os dados do seu perfil. Você pode alterar à vontade — muda só neste anúncio. "}
                    {perfilIncompleto && (
                      <>
                        <Link to={createPageUrl("Conta")} className="font-medium text-orange-600 hover:underline dark:text-orange-400">
                          Complete seu perfil
                        </Link>{" "}
                        para preencher os próximos anúncios automaticamente.
                      </>
                    )}
                  </p>
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="ad-name" className="text-sm font-medium text-slate-700 dark:text-slate-200">Nome da Empresa *</Label>
                  <Input id="ad-name" required value={form.business_name} onChange={(e) => handleChange("business_name", e.target.value)} placeholder="Nome fantasia" className="mt-1.5 h-11 rounded-card" />
                </div>
                <div>
                  <Label htmlFor="ad-cnpj" className="text-sm font-medium text-slate-700 dark:text-slate-200">CNPJ *</Label>
                  {profileCnpj ? (
                    <>
                      <div className="relative mt-1.5">
                        <Input id="ad-cnpj" readOnly value={profileCnpj} className="h-11 rounded-card bg-slate-50 pr-9 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300" />
                        <Lock className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      </div>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        CNPJ do seu perfil. Para mudar, edite em{" "}
                        <Link to={createPageUrl("Conta")} className="text-orange-600 hover:underline dark:text-orange-400">Minha Conta</Link>.
                        {isEdit && form.cnpj && form.cnpj !== profileCnpj && " Ao salvar, este anúncio passa a usar este CNPJ."}
                      </p>
                    </>
                  ) : (
                    <Input id="ad-cnpj" required value={form.cnpj} onChange={(e) => handleChange("cnpj", formatCNPJ(e.target.value))} placeholder="00.000.000/0000-00" maxLength={18} autoCapitalize="characters" className="mt-1.5 h-11 rounded-card" />
                  )}
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Descrição</Label>
                <Textarea value={form.description} onChange={(e) => handleChange("description", e.target.value)} placeholder="Descreva seus produtos, serviços e diferenciais..." className="mt-1.5 rounded-card h-28" />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Categoria *</Label>
                  {/* required: o rótulo tinha asterisco, mas o anúncio podia
                      ser publicado sem categoria -- e então não aparecia em
                      nenhum filtro de categoria da listagem. */}
                  <Select required value={form.category || ""} onValueChange={(v) => handleChange("category", v)}>
                    <SelectTrigger className="mt-1.5 h-11 rounded-card"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <CategoryHint category={form.category} />
                </div>
                <div>
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Localização *</Label>
                  <Input required value={form.location} onChange={(e) => handleChange("location", e.target.value)} placeholder="São Paulo, SP" className="mt-1.5 h-11 rounded-card" />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Telefone</Label>
                  <Input value={form.phone} onChange={(e) => handleChange("phone", e.target.value)} placeholder="(11) 99999-9999" className="mt-1.5 h-11 rounded-card" />
                </div>
                <div>
                  {/* E-mail de CONTATO, público no anúncio -- não é o e-mail de
                      login e não precisa ser. O chat não depende dele: as
                      mensagens chegam à conta dona do anúncio (seção 166). */}
                  <Label htmlFor="ad-email" className="text-sm font-medium text-slate-700 dark:text-slate-200">E-mail de contato</Label>
                  <Input id="ad-email" type="email" value={form.email || ""} onChange={(e) => handleChange("email", e.target.value)} placeholder="contato@empresa.com" className="mt-1.5 h-11 rounded-card" />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Aparece no anúncio para quem está logado. Pode ser diferente do seu e-mail de login. Deixe vazio para não mostrar.
                  </p>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Website / Rede Social</Label>
                  <Input value={form.website} onChange={(e) => handleChange("website", e.target.value)} placeholder="www.empresa.com.br" className="mt-1.5 h-11 rounded-card" />
                </div>
                <div>
                  <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Pedido Mínimo</Label>
                  <Input value={form.min_order} onChange={(e) => handleChange("min_order", e.target.value)} placeholder="R$ 100 / 50 unidades" className="mt-1.5 h-11 rounded-card" />
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium text-slate-700 dark:text-slate-200">Informações de Entrega</Label>
                <Input value={form.delivery_info} onChange={(e) => handleChange("delivery_info", e.target.value)} placeholder="Todo o Brasil" className="mt-1.5 h-11 rounded-card" />
              </div>

              {/* DESTAQUES: o campo existia no banco, a página do anúncio os
                  mostra e a busca os usa -- mas não havia onde preenchê-los. */}
              <div>
                <div className="flex items-end justify-between gap-3">
                  <Label htmlFor="tag-draft" className="text-sm font-medium text-slate-700 dark:text-slate-200">Destaques</Label>
                  <span className="tnum text-xs text-slate-400 dark:text-slate-500">{(form.tags || []).length} de {MAX_TAGS}</span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Diferenciais do seu negócio, um por vez. Aparecem em lista no anúncio e ajudam a achar você na busca.
                </p>
                {(form.tags || []).length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {form.tags.map((tag) => (
                      <li key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 py-1 pl-3 pr-1.5 text-sm text-slate-700 dark:border-orange-900/50 dark:bg-orange-500/10 dark:text-slate-200">
                        {tag}
                        <button type="button" onClick={() => removeTag(tag)} aria-label={`Remover destaque ${tag}`} className="rounded-full p-0.5 text-slate-400 hover:bg-orange-100 hover:text-slate-700 dark:hover:bg-orange-500/20 dark:hover:text-slate-100">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {(form.tags || []).length < MAX_TAGS && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      id="tag-draft"
                      value={tagDraft}
                      maxLength={MAX_TAG_LENGTH}
                      onChange={(e) => setTagDraft(e.target.value)}
                      // Enter adiciona o destaque em vez de enviar o formulário.
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
                      placeholder="Ex.: Entrega em 24h para a capital"
                      className="h-11 rounded-card"
                    />
                    <Button type="button" variant="outline" onClick={addTag} disabled={!tagDraft.trim()} className="h-11 rounded-card">
                      Adicionar
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Produtos */}
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[14rem] flex-1">
                  <h2 className="font-semibold text-slate-800 dark:text-slate-100">Produtos / Serviços</h2>
                  {/* O catálogo inteiro aparece aqui como OPÇÕES, e isso parecia
                      "o anúncio mostra todos os produtos" (seção 172). O texto diz
                      o que a marcação faz, e o contador diz quantos vão. */}
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Só os produtos marcados aparecem neste anúncio. O catálogo completo aparece no perfil da empresa.
                  </p>
                  {catalogProducts.length > 0 && (
                    <p aria-live="polite" className="tnum mt-1.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
                      {selectedProductIds.size} de {catalogProducts.length} {catalogProducts.length === 1 ? "produto selecionado" : "produtos selecionados"}
                    </p>
                  )}
                </div>
                <Link to={createPageUrl("Catalogo")}>
                  <Button type="button" variant="outline" size="sm" className="rounded-card gap-1.5 border-orange-200 dark:border-orange-900/50 text-orange-600 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-500/10">
                    <Package className="w-4 h-4" /> Gerenciar catálogo
                  </Button>
                </Link>
              </div>

              {catalogProducts.length === 0 ? (
                <div className="text-center py-8 rounded-card border-2 border-dashed border-slate-100 dark:border-slate-800">
                  <Store className="w-8 h-8 text-slate-200 dark:text-slate-700 mx-auto mb-2" />
                  <p className="text-slate-400 dark:text-slate-500 text-sm">
                    Você ainda não tem produtos no catálogo.{" "}
                    <Link to={createPageUrl("Catalogo")} className="text-orange-600 dark:text-orange-400 hover:underline">
                      Criar agora
                    </Link>
                  </p>
                </div>
              ) : (
                <>
                <div className="flex flex-wrap items-center gap-2">
                  {catalogProducts.length >= PRODUCT_SEARCH_MIN && (
                    <div className="relative min-w-[12rem] flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        type="search"
                        value={productSearch}
                        onChange={(e) => setProductSearch(e.target.value)}
                        placeholder="Buscar no catálogo"
                        aria-label="Buscar produto no catálogo"
                        className="h-9 rounded-card pl-9"
                      />
                    </div>
                  )}
                  <div className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={selectAllVisible}
                      disabled={allVisibleSelected}
                      className="text-slate-600 dark:text-slate-300"
                    >
                      {!productSearch.trim()
                        ? "Selecionar todos"
                        : visibleCatalog.length === 1
                          ? "Selecionar o encontrado"
                          : `Selecionar os ${visibleCatalog.length} encontrados`}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedProductIds(new Set())}
                      disabled={selectedProductIds.size === 0}
                      className="text-slate-600 dark:text-slate-300"
                    >
                      Limpar seleção
                    </Button>
                  </div>
                </div>
                {visibleCatalog.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-400 dark:text-slate-500">
                    Nenhum produto com "{productSearch.trim()}".
                  </p>
                ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {visibleCatalog.map((product) => (
                    <CatalogProductPickerItem
                      key={product.id}
                      product={product}
                      imageUrl={catalogImages[product.id]}
                      selected={selectedProductIds.has(product.id)}
                      onToggle={() => toggleProductSelection(product.id)}
                    />
                  ))}
                </div>
                )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Submit */}
          <div className="flex gap-3 pb-8">
            <Link to={createPageUrl("Dashboard")} className="flex-1">
              <Button type="button" variant="outline" className="w-full h-12 rounded-card">Cancelar</Button>
            </Link>
            <Button type="submit" disabled={saving} className="flex-1 h-12 rounded-card bg-orange-500 hover:bg-orange-600 text-white font-semibold gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-4 h-4" />{isEdit ? "Salvar Alterações" : "Criar Anúncio"}</>}
            </Button>
          </div>
          {saveError && (
            <div role="alert" className="mb-8 rounded-card border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-400">
              {saveError}
            </div>
          )}
        </form>
      </div>
    </div>
  );
}