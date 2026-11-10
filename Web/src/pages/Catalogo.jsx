import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { createPageUrl } from "@/utils";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { hasUsableBenefits } from "@/lib/subscription";
import { PLAN_LABELS, getPlanProductLimit, getPlanProductTotalLimit, getPlanProductImageLimit, formatProductLimit } from "@/lib/plans";
import { getItemState, ITEM_STATE_LABELS, countItemStates, describeSuspension, planRuleErrorMessage } from "@/lib/itemStatus";
import { CATEGORIES } from "@/lib/categories";
import CategoryHint from "@/components/shared/CategoryHint";
import { DEFAULT_UNIT, getUnitGroupsForCategory, getDefaultUnitForCategory } from "@/lib/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import ProductCardMini from "@/components/supplier/ProductCardMini";
import SwapSlotDialog from "@/components/shared/SwapSlotDialog";
import { ArrowLeft, Loader2, Package, Plus, Pencil, Trash2, ImagePlus, X, Pause, Play } from "lucide-react";

const PRODUCT_STATE_BADGE = {
  paused: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  suspended_plan_limit: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  suspended_no_plan: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

const emptyForm = { name: "", category: "", description: "", price: "", unit: DEFAULT_UNIT, min_quantity: 1, in_stock: true };

export default function Catalogo() {
  const { user, isLoadingAuth, authChecked } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (authChecked && !user) {
      api.auth.redirectToLogin("/Catalogo");
    }
  }, [authChecked, user]);

  const { data: subscription } = useQuery({
    queryKey: ["my-subscription-catalog", user?.email],
    queryFn: () => api.subscriptions.getCurrent(),
    enabled: !!user,
  });

  const hasPlan = hasUsableBenefits(subscription);
  const planId = subscription?.plan_id;
  // Dois limites (seção 185): ATIVOS (o que aparece no site) e TOTAL de
  // cadastrados. Têm o mesmo valor por decisão do usuário (seção 194).
  const productLimit = hasPlan ? getPlanProductLimit(planId) : 0;
  const productTotalLimit = hasPlan ? getPlanProductTotalLimit(planId) : 0;
  const imageLimit = hasPlan ? getPlanProductImageLimit(planId) : 0;

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["my-products", user?.email],
    queryFn: () => api.entities.Product.filter({ created_by: user.email }, "-created_date"),
    enabled: !!user?.email,
  });

  const productIds = products.map((p) => p.id);

  const { data: imagesByProduct = {} } = useQuery({
    queryKey: ["my-product-images", productIds],
    queryFn: async () => {
      const perProduct = await Promise.all(
        productIds.map((id) => api.entities.ProductImage.filter({ product_id: id }, "position"))
      );
      return Object.fromEntries(productIds.map((id, index) => [id, perProduct[index]]));
    },
    enabled: productIds.length > 0,
  });

  const refetchCatalog = () => {
    queryClient.invalidateQueries({ queryKey: ["my-products", user?.email] });
    queryClient.invalidateQueries({ queryKey: ["my-product-images"] });
  };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formImages, setFormImages] = useState([]); // [{ id?, url }]
  const [uploadingImage, setUploadingImage] = useState(false);
  const [saving, setSaving] = useState(false);
  // Se o fornecedor ainda não escolheu a unidade, trocar a categoria troca a
  // unidade junto (logística -> "envio"). Depois que ele escolhe, a escolha
  // dele manda. Na edição começa como true: não mexer no que já foi salvo.
  const [unitTouched, setUnitTouched] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [createdProduct, setCreatedProduct] = useState(null);

  const [togglingId, setTogglingId] = useState(null);
  // Produto suspenso pelo limite que a pessoa quer pôr no ar (troca manual).
  const [swapTarget, setSwapTarget] = useState(null);
  const productStates = countItemStates(products);
  // Cadastrar novo depende do TOTAL; ativar depende dos ATIVOS.
  const atProductLimit = products.length >= productTotalLimit;
  const atActiveLimit = productStates.active >= productLimit;

  // Pausar/ativar. Suspenso é do sistema: o banco recusa (PRODUCT_SUSPENDED),
  // então o botão nem aparece -- aqui é só a rede de segurança.
  const handleToggleProduct = async (product) => {
    if (product.status === "suspended") {
      toast(describeSuspension(product, "produto"));
      return;
    }
    const nextStatus = getItemState(product) === "active" ? "paused" : "active";
    setTogglingId(product.id);
    try {
      await api.entities.Product.update(product.id, { status: nextStatus });
      toast({ title: nextStatus === "active" ? "Produto ativado" : "Produto pausado" });
      refetchCatalog();
    } catch (error) {
      toast({
        title: "Não foi possível atualizar o produto",
        description: planRuleErrorMessage(error.message, "produto") || error.message,
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
  };

  const openCreateDialog = () => {
    setEditingProduct(null);
    setCreatedProduct(null);
    setForm(emptyForm);
    setUnitTouched(false);
    setFormImages([]);
    setDialogOpen(true);
  };

  const openEditDialog = (product) => {
    setEditingProduct(product);
    setCreatedProduct(null);
    setForm({
      name: product.name || "",
      category: product.category || "",
      description: product.description || "",
      price: product.price ?? "",
      unit: product.unit || DEFAULT_UNIT,
      min_quantity: product.min_quantity || 1,
      in_stock: product.in_stock !== false,
    });
    setUnitTouched(true);
    setFormImages((imagesByProduct[product.id] || []).map((img) => ({ id: img.id, url: img.url })));
    setDialogOpen(true);
  };

  const handleChange = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleCategoryChange = (category) => {
    setForm((prev) => ({
      ...prev,
      category,
      unit: unitTouched ? prev.unit : getDefaultUnitForCategory(category),
    }));
  };

  const handleUnitChange = (unit) => {
    setUnitTouched(true);
    handleChange("unit", unit);
  };

  const unitGroups = getUnitGroupsForCategory(form.category, form.unit);

  const handleAddImage = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingImage(true);
    try {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      setFormImages((prev) => [...prev, { url: file_url }]);
    } catch (error) {
      toast({ title: "Não foi possível enviar a imagem", description: error.message, variant: "destructive" });
    } finally {
      setUploadingImage(false);
    }
  };

  const handleRemoveImage = (index) => {
    setFormImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    let produtoExistente_ = null;
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category,
        description: form.description,
        price: form.price === "" ? null : Number(form.price),
        unit: form.unit,
        min_quantity: Number(form.min_quantity) || 1,
        in_stock: form.in_stock,
      };

      // Produto que já existe: o que está em edição, OU o criado numa
      // tentativa anterior deste mesmo diálogo que falhou nas fotos. Antes, o
      // segundo clique em "Criar Produto" criava um produto DUPLICADO.
      const produtoExistente = editingProduct || createdProduct;
      if (produtoExistente) {
        await api.entities.Product.update(produtoExistente.id, payload);
      } else {
        const created = await api.entities.Product.create(payload);
        setCreatedProduct(created);
        produtoExistente_ = created;
      }
      const alvo = produtoExistente || produtoExistente_;

      // FOTOS: apaga as que saíram e grava a posição de TODAS na ordem da
      // tela. Antes, a foto nova recebia "quantas sobraram" como posição, e
      // isso podia repetir a posição de uma que ficou (tirar a 1ª de 3 e pôr
      // uma nova dava duas na posição 2) -- a ordem pública ficava sorteada.
      //
      // Em série: o trigger de limite de fotos conta as linhas existentes, e
      // inserções em paralelo liam todas a mesma contagem.
      const originalImages = imagesByProduct[alvo.id] || [];
      const keptIds = new Set(formImages.filter((img) => img.id).map((img) => img.id));
      for (const img of originalImages.filter((i) => !keptIds.has(i.id))) {
        await api.entities.ProductImage.delete(img.id);
      }
      const gravadas = [];
      try {
        for (let index = 0; index < formImages.length; index += 1) {
          const img = formImages[index];
          if (img.id) {
            const original = originalImages.find((o) => o.id === img.id);
            if (original?.position !== index) await api.entities.ProductImage.update(img.id, { position: index });
            gravadas.push(img);
          } else {
            const nova = await api.entities.ProductImage.create({ product_id: alvo.id, url: img.url, position: index });
            gravadas.push({ id: nova.id, url: nova.url });
          }
        }
      } finally {
        // Mesmo se uma foto falhar no meio: as que já foram gravadas passam a
        // ter id no formulário, e a nova tentativa não as grava de novo.
        setFormImages([...gravadas, ...formImages.slice(gravadas.length)]);
      }

      // Criado além do limite de ATIVOS (cabendo no total): o banco grava
      // pausado. Dizer isso -- senão a pessoa procura o produto no site.
      if (produtoExistente_?.status === "paused") {
        toast({
          title: "Produto criado como pausado",
          description: "Você já tem o máximo de produtos ativos do seu plano. Pause outro para ativar este.",
        });
      } else {
        toast({ title: editingProduct ? "Produto atualizado" : "Produto criado" });
      }
      setDialogOpen(false);
      setCreatedProduct(null);
      refetchCatalog();
    } catch (error) {
      // Criou o produto mas falhou numa foto: o produto já aparece no
      // catálogo, e o diálogo continua aberto para concluir.
      if (produtoExistente_ || createdProduct) refetchCatalog();
      const isImageLimit = /PLAN_LIMIT/.test(error.message || "") && /imagens/i.test(error.message || "");
      toast({
        title: "Não foi possível salvar o produto",
        description: isImageLimit
          ? "Você atingiu o limite de imagens por produto do seu plano."
          : planRuleErrorMessage(error.message, "produto")
            || (error.code === "42501" ? "Você atingiu o limite do seu plano." : error.message),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (productId) => {
    setDeletingId(productId);
    try {
      await api.entities.Product.delete(productId);
      toast({ title: "Produto excluído" });
      refetchCatalog();
    } catch (error) {
      toast({ title: "Não foi possível excluir o produto", description: error.message, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  if (isLoadingAuth || !user) {
    return <div className="min-h-screen flex items-center justify-center"><div className="w-8 h-8 border-4 border-slate-200 border-t-orange-500 rounded-full animate-spin" /></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center gap-4">
          <Link to={createPageUrl("Dashboard")}>
            <Button variant="ghost" size="sm" className="text-slate-500 dark:text-slate-400 gap-1.5">
              <ArrowLeft className="w-4 h-4" /> Dashboard
            </Button>
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="font-display font-extrabold text-slate-900 dark:text-slate-50">Catálogo de Produtos ou Serviços</h1>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
          <CardContent className="p-5 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {hasPlan ? (
                  <>
                    {productLimit === Infinity
                      ? `${products.length} ${products.length === 1 ? "produto" : "produtos"} no catálogo · ilimitado no plano ${PLAN_LABELS[planId]}`
                      : `${productStates.active} de ${productLimit} produtos ativos no plano ${PLAN_LABELS[planId]} · ${products.length} de ${productTotalLimit} cadastrados`}
                  </>
                ) : (
                  "Você precisa de um plano ativo para criar produtos no catálogo."
                )}
              </p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                {hasPlan
                  ? `Até ${formatProductLimit(imageLimit)} imagens por produto no seu plano`
                  : "Escolha um plano para começar a montar seu catálogo."}
              </p>
              {(productStates.paused > 0 || productStates.suspended_plan_limit > 0 || productStates.suspended_no_plan > 0) && (
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {"Fora do site: "}
                  {[
                    productStates.paused > 0 && `${productStates.paused} pausado(s) por você`,
                    productStates.suspended_plan_limit > 0 && `${productStates.suspended_plan_limit} suspenso(s) pelo limite do plano`,
                    productStates.suspended_no_plan > 0 && `${productStates.suspended_no_plan} suspenso(s) por falta de plano`,
                  ].filter(Boolean).join(" · ")}
                  {". Nada foi apagado."}
                  {productStates.suspended_plan_limit > 0 && " Use “Colocar no ar” para escolher quais ficam no site."}
                </p>
              )}
            </div>
            {!hasPlan || atProductLimit ? (
              <Link to={`${createPageUrl("Planos")}?manage=1`}>
                <Button variant="outline" className="rounded-card">
                  {hasPlan ? "Mudar de plano" : "Ver planos"}
                </Button>
              </Link>
            ) : (
              <Button onClick={openCreateDialog} className="rounded-card bg-orange-500 hover:bg-orange-600 text-white gap-2">
                <Plus className="w-4 h-4" /> Novo Produto
              </Button>
            )}
          </CardContent>
        </Card>

        {isLoading ? (
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => <div key={i} className="h-56 rounded-card bg-slate-100 dark:bg-slate-800 animate-pulse" />)}
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-16 rounded-card border-2 border-dashed border-slate-200 dark:border-slate-800">
            <Package className="w-10 h-10 text-slate-200 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-slate-400 dark:text-slate-500 text-sm">Nenhum produto no catálogo ainda.</p>
          </div>
        ) : (
          // auto-rows-fr: todas as linhas com a altura da mais alta, então todo
          // card tem o mesmo tamanho, não só os da mesma linha (seção 153).
          <div className="grid auto-rows-fr sm:grid-cols-2 md:grid-cols-3 gap-4">
            {products.map((product) => (
              <div key={product.id} className="flex flex-col">
                {/* interativo={false}: aqui o card já vive dentro de um item
                    com Editar/Excluir logo abaixo. Abrir o painel de detalhe
                    ao clicar brigaria com a edição -- esta é a tela de
                    GERIR o produto, não de olhá-lo como comprador. */}
                <div className="relative flex-1 flex flex-col">
                  <ProductCardMini interativo={false} className="flex-1" product={product} images={(imagesByProduct[product.id] || []).map((img) => img.url)} />
                  {getItemState(product) !== "active" && (
                    <span className={`absolute top-2 left-2 rounded-full px-2 py-0.5 text-xs font-medium ${PRODUCT_STATE_BADGE[getItemState(product)]}`}>
                      {ITEM_STATE_LABELS[getItemState(product)]}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-2">
                  {getItemState(product) === "suspended_plan_limit" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSwapTarget({ id: product.id, name: product.name })}
                      title="Escolher qual produto ativo sai do ar no lugar deste"
                      className="rounded-lg text-xs font-semibold"
                    >
                      Colocar no ar
                    </Button>
                  )}
                  {product.status !== "suspended" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={togglingId === product.id || (getItemState(product) === "paused" && atActiveLimit)}
                      onClick={() => handleToggleProduct(product)}
                      title={
                        getItemState(product) === "active"
                          ? "Pausar: sai do site e libera uma vaga"
                          : atActiveLimit
                            ? "Você já tem o máximo de produtos ativos do plano"
                            : "Ativar: volta a aparecer no site"
                      }
                      aria-label={`${getItemState(product) === "active" ? "Pausar" : "Ativar"} produto ${product.name}`}
                      className="rounded-lg"
                    >
                      {getItemState(product) === "active" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => openEditDialog(product)} className="flex-1 rounded-lg gap-1.5">
                    <Pencil className="w-3.5 h-3.5" /> Editar
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" disabled={deletingId === product.id} className="rounded-lg text-red-500 hover:text-red-600 border-red-200 dark:border-red-900/50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Excluir produto?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Tem certeza que deseja excluir <strong>{product.name}</strong>? Ele também sairá de qualquer anúncio onde está vinculado. Esta ação não pode ser desfeita.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancelar</AlertDialogCancel>
                        <AlertDialogAction onClick={() => handleDelete(product.id)} className="bg-red-500 hover:bg-red-600">
                          Excluir
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProduct ? "Editar Produto" : "Novo Produto"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-slate-500 dark:text-slate-400">Nome *</Label>
                <Input required value={form.name} onChange={(e) => handleChange("name", e.target.value)} placeholder="Nome do produto" className="mt-1 rounded-lg h-10" />
              </div>
              <div>
                <Label className="text-xs text-slate-500 dark:text-slate-400">Categoria *</Label>
                <Select required value={form.category} onValueChange={handleCategoryChange}>
                  <SelectTrigger className="mt-1 rounded-lg h-10"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <CategoryHint category={form.category} />
              </div>
            </div>

            <div>
              <Label className="text-xs text-slate-500 dark:text-slate-400">Descrição</Label>
              <Textarea value={form.description} onChange={(e) => handleChange("description", e.target.value)} placeholder="Descreva o produto..." className="mt-1 rounded-lg h-20" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs text-slate-500 dark:text-slate-400">Preço (R$)</Label>
                <Input type="number" step="0.01" value={form.price} onChange={(e) => handleChange("price", e.target.value)} placeholder="0,00" className="mt-1 rounded-lg h-10" />
              </div>
              <div>
                <Label className="text-xs text-slate-500 dark:text-slate-400">Unidade</Label>
                <Select value={form.unit} onValueChange={handleUnitChange}>
                  <SelectTrigger className="mt-1 rounded-lg h-10"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    {unitGroups.map((group, index) => (
                      <SelectGroup key={group.key}>
                        {index > 0 && <SelectSeparator />}
                        <SelectLabel className="text-xs text-slate-500 dark:text-slate-400">
                          {group.label}
                          {group.suggested && <span className="ml-1.5 font-normal text-orange-600 dark:text-orange-400">· sugerido</span>}
                        </SelectLabel>
                        {group.units.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs text-slate-500 dark:text-slate-400">Qtd. Mínima</Label>
                <Input type="number" min="1" value={form.min_quantity} onChange={(e) => handleChange("min_quantity", Number(e.target.value))} className="mt-1 rounded-lg h-10" />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5">
              <Label className="text-sm text-slate-600 dark:text-slate-300">Disponível em estoque</Label>
              <Switch checked={form.in_stock} onCheckedChange={(v) => handleChange("in_stock", v)} />
            </div>

            <div>
              <Label className="text-xs text-slate-500 dark:text-slate-400">
                Fotos ({formImages.length}/{formatProductLimit(imageLimit)})
              </Label>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {formImages.map((img, index) => (
                  <div key={img.id || img.url} className="relative aspect-square">
                    <img src={img.url} alt="" className="w-full h-full object-cover rounded-lg border border-slate-200 dark:border-slate-700" />
                    <button type="button" onClick={() => handleRemoveImage(index)} className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {formImages.length < imageLimit && (
                  <label className="aspect-square flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-700 cursor-pointer hover:border-orange-400 hover:bg-orange-50/30 dark:hover:bg-orange-500/10 transition-all">
                    {uploadingImage ? <Loader2 className="w-5 h-5 text-orange-500 animate-spin" /> : <ImagePlus className="w-6 h-6 text-slate-300 dark:text-slate-600" />}
                    <input type="file" accept="image/*" className="hidden" onChange={handleAddImage} disabled={uploadingImage} />
                  </label>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} className="rounded-card">Cancelar</Button>
              <Button type="submit" disabled={saving || uploadingImage} className="rounded-card bg-orange-500 hover:bg-orange-600 text-white gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : (editingProduct ? "Salvar Alterações" : "Criar Produto")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SwapSlotDialog
        open={!!swapTarget}
        onOpenChange={(open) => !open && setSwapTarget(null)}
        kind="product"
        noun="produto"
        target={swapTarget}
        candidates={products
          .filter((p) => getItemState(p) === "active")
          .map((p) => ({ id: p.id, name: p.name }))}
        onSwapped={refetchCatalog}
      />
    </div>
  );
}
