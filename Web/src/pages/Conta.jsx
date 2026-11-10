import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  User, Mail, Phone, MapPin, Building2, Pencil, Save, X,
  Camera, ShieldCheck, ArrowLeft, Loader2, LogOut, Lock, Settings, AlertTriangle
} from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { motion } from "framer-motion";
import { useToast } from "@/components/ui/use-toast";
import { useAuth } from "@/lib/AuthContext";
import { hasUsableBenefits } from "@/lib/subscription";
import { CATEGORIES, CATEGORY_LABELS, CATEGORY_KEYS } from "@/lib/categories";
import CategoryHint from "@/components/shared/CategoryHint";
import { isValidCNPJ, formatCNPJ } from "@/lib/cnpj";
import { useCnpjLookup, CnpjLookupButton, CnpjLookupResult } from "@/components/shared/CnpjLookup";
import { useCepLookup, CepLookupSpinner, CepLookupResult } from "@/components/shared/CepLookup";
import { formatCEP, isValidCEP, cepForStorage, saveWithOptionalCep } from "@/lib/cep";

const STATES = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

const EMPTY_FORM = {
  full_name: "",
  phone: "",
  city: "",
  state: "",
  company_name: "",
  cnpj: "",
  cep: "",
  segment: "",
  avatar_url: "",
  cover_url: "",
  company_description: "",
};

export default function Conta() {
  const { toast } = useToast();
  const { user, isLoadingAuth, authChecked, logout } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  // Lido dentro do loadData, que não pode depender de editMode (recriaria o
  // callback e dispararia o efeito de carga a cada Editar/Cancelar).
  const editModeRef = useRef(false);
  editModeRef.current = editMode;
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [subscription, setSubscription] = useState(null);

  const [form, setForm] = useState(EMPTY_FORM);
  // Só preenche o formulário desta conta; nada vai para os anúncios.
  const consultaCnpj = useCnpjLookup(form.cnpj);
  // CEP sem botão (seção 206): consulta sozinha, mas só depois que a pessoa
  // MEXE no campo -- senão o CEP já salvo seria consultado toda vez que ela
  // abre a edição.
  const [cepTocado, setCepTocado] = useState(false);
  const consultaCep = useCepLookup(form.cep, { auto: editMode && cepTocado });

  // Sem este redirect, /Conta deslogado abria a tela vazia ("Sem nome", com
  // botão Editar Perfil) em vez de pedir login -- toda outra página de conta
  // já fazia isso (seção 165).
  useEffect(() => {
    if (authChecked && !user) {
      api.auth.redirectToLogin("/Conta");
    }
  }, [authChecked, user]);

  const isFornecedor = user?.role === "fornecedor" || user?.role === "admin";

  const loadData = useCallback(async ({ force = false } = {}) => {
    if (!user) {
      setProfile(null);
      setForm(EMPTY_FORM);
      setLoading(false);
      return;
    }

    // Recarga que não foi pedida (a do efeito) não mexe no formulário se a
    // pessoa estiver editando QUANDO A RESPOSTA CHEGA -- uma leitura que
    // começou antes do "Editar Perfil" e voltou depois apagava o que ela
    // tinha digitado (seção 204). Salvar e Cancelar pedem `force`.
    const editando = () => !force && editModeRef.current;
    if (!editando()) setLoading(true);

    try {
      let profiles = [];
      if (user.id) {
        profiles = await api.entities.UserProfile.filter({ created_by: user.id });
      }

      if (!profiles.length && user.email) {
        profiles = await api.entities.UserProfile.filter({ created_by: user.email });
      }

      const p = profiles[0] || null;
      setProfile(p);
      if (editando()) return;

      setForm({
        full_name: p?.full_name || user.full_name || "",
        phone: p?.phone || "",
        city: p?.city || "",
        state: p?.state || "",
        company_name: p?.company_name || "",
        cnpj: p?.cnpj || "",
        cep: p?.cep ? formatCEP(p.cep) : "",
        segment: p?.segment || "",
        avatar_url: p?.avatar_url || "",
        cover_url: p?.cover_url || "",
        company_description: p?.company_description || "",
      });
    } catch (error) {
      console.error("Erro ao carregar dados da conta:", error);
      setProfile(null);
      toast({
        title: "Não foi possível carregar sua conta",
        description: error.message || "Verifique sua sessão e o cadastro no Supabase.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    if (isLoadingAuth) return;
    loadData();
  }, [isLoadingAuth, loadData]);

  // Assinatura real do usuário (fonte da verdade para o selo "Verificado" e para
  // liberar a descrição da empresa) -- mesma chamada usada em Dashboard.jsx/AdEditor.jsx,
  // nunca supplier.verified ou um campo solto em user_profiles.
  useEffect(() => {
    if (isLoadingAuth) return;
    if (!user) {
      setSubscription(null);
      return;
    }
    let cancelled = false;
    api.subscriptions.getCurrent()
      .then((sub) => {
        if (!cancelled) setSubscription(sub);
      })
      .catch((error) => {
        console.error("Erro ao carregar assinatura:", error);
        if (!cancelled) setSubscription(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user, isLoadingAuth]);

  // Os console.log marcados "[DIAGNÓSTICO TEMPORÁRIO — remover]" que moravam
  // aqui saíram na auditoria (seção 165): o upload funciona desde a seção 141.
  async function uploadImageField(file, field, setUploadingFlag) {
    if (!file) return;

    setUploadingFlag(true);
    try {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      setForm((f) => ({ ...f, [field]: file_url }));
    } catch (error) {
      console.error(`Erro ao enviar imagem (${field}):`, error);
      toast({
        title: "Não foi possível enviar a imagem",
        description: "Tente novamente em instantes.",
        variant: "destructive",
      });
    } finally {
      setUploadingFlag(false);
    }
  }

  // value = "" logo depois de ler: sem isto, escolher o mesmo arquivo de novo
  // (depois de um erro, por exemplo) não dispara change.
  const handleAvatarUpload = (e) => { const f = e.target.files[0]; e.target.value = ""; uploadImageField(f, "avatar_url", setUploadingAvatar); };
  const handleCoverUpload = (e) => { const f = e.target.files[0]; e.target.value = ""; uploadImageField(f, "cover_url", setUploadingCover); };
  const handleRemoveCover = () => setForm((f) => ({ ...f, cover_url: "" }));

  function getMissingRequiredFields() {
    // OS MESMOS obrigatórios do cadastro (Register.jsx). Antes esta tela
    // exigia também telefone, cidade, UF e segmento, que no cadastro são
    // opcionais -- quem acabava de se cadastrar não conseguia nem corrigir o
    // próprio nome sem preencher quatro campos que ninguém tinha pedido.
    const requiredFields = [
      { key: "full_name", label: "Nome completo" },
      { key: "company_name", label: "Razão Social" },
      { key: "cnpj", label: "CNPJ" },
    ];
    return requiredFields.filter(({ key }) => !String(form[key] || "").trim());
  }

  async function handleSave() {
    const missingFields = getMissingRequiredFields();
    if (missingFields.length) {
      toast({
        title: "Preencha os campos obrigatórios",
        description: `Faltam: ${missingFields.map((f) => f.label).join(", ")}.`,
        variant: "destructive",
      });
      return;
    }

    // CNPJ só é validado quando MUDA: perfis antigos podem ter um CNPJ que não
    // passa nos dígitos verificadores (o cadastro não validava até a seção
    // 161), e exigir a correção travaria qualquer outra edição. O aviso de
    // CNPJ inválido aparece na tela para esses casos.
    const cnpjMudou = (form.cnpj || "") !== (profile?.cnpj || "");
    if (cnpjMudou && !isValidCNPJ(form.cnpj)) {
      toast({
        title: "CNPJ inválido",
        description: "Confira os números: os dois últimos dígitos não batem com o resto.",
        variant: "destructive",
      });
      return;
    }
    // CEP é opcional, mas começado tem de estar completo.
    if (form.cep && !isValidCEP(form.cep)) {
      toast({
        title: "CEP incompleto",
        description: "Digite os 8 números do CEP ou deixe o campo vazio.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      // Tipo da conta pelo PAPEL do login quando ainda não há perfil. O
      // fallback fixo em "cliente" gravava cliente num fornecedor sem perfil
      // (conta criada antes da correção da seção 161, por exemplo).
      // CEP vai só com dígitos, e só quando MUDOU: enquanto
      // supabase/user-profile-cep.sql não rodar, um `cep` em todo save
      // faria cada "Salvar" bater na coluna inexistente (seção 205).
      const { cep, ...resto } = form;
      const cepMudou = cepForStorage(cep) !== cepForStorage(profile?.cep);
      const data = {
        ...resto,
        ...(cepMudou ? { cep: cepForStorage(cep) } : {}),
        email: user.email,
        user_type: profile?.user_type || (isFornecedor ? "fornecedor" : "cliente"),
      };
      if (profile) {
        await saveWithOptionalCep((d) => api.entities.UserProfile.update(profile.id, d), data);
      } else {
        const newProfile = await saveWithOptionalCep((d) => api.entities.UserProfile.create(d), data);
        setProfile(newProfile);
      }
      await loadData({ force: true });
      setEditMode(false);
      consultaCnpj.descartar();
      consultaCep.descartar();
      setCepTocado(false);
      toast({ title: "Dados salvos com sucesso!" });
    } catch (error) {
      console.error("Erro ao salvar perfil:", error);
      toast({
        title: "Não foi possível salvar seus dados",
        description: error?.message || "Verifique as informações e tente novamente.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setEditMode(false);
    consultaCnpj.descartar();
    consultaCep.descartar();
    setCepTocado(false);
    loadData({ force: true });
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
      </div>
    );
  }

  const initials = form.full_name
    ? form.full_name.split(" ").slice(0, 2).map((n) => n[0]).join("").toUpperCase()
    : "?";
  // Selo "Verificado" e liberação da descrição da empresa: sempre a partir da
  // assinatura real (subscriptions), nunca de supplier.verified ou de "tem CNPJ".
  const planId = subscription?.plan_id || null;
  const hasBenefits = hasUsableBenefits(subscription);
  const isPremiumVerified = hasBenefits && planId === "premium";
  const canEditDescription = hasBenefits && (planId === "profissional" || planId === "premium");

  const segmentLabel = CATEGORY_LABELS[form.segment] || form.segment;
  // CNPJ salvo que não passa na validação (perfis de antes da seção 161).
  const cnpjSalvoInvalido = !!profile?.cnpj && !isValidCNPJ(profile.cnpj);

  const segmentOptions = form.segment && !CATEGORY_KEYS.has(form.segment)
    ? [...CATEGORIES, { key: form.segment, label: `${form.segment} (valor atual)` }]
    : CATEGORIES;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center gap-4">
          {/* Cliente não tem Dashboard (a NavBar nem mostra "Meu painel"
              para ele) -- o link de volta levava a um painel de fornecedor. */}
          <Link to={createPageUrl(isFornecedor ? "Dashboard" : "Suppliers")}>
            <Button variant="ghost" size="sm" className="text-slate-500 dark:text-slate-400 gap-1.5">
              <ArrowLeft className="w-4 h-4" /> {isFornecedor ? "Dashboard" : "Fornecedores"}
            </Button>
          </Link>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="font-bold text-slate-900 dark:text-slate-50">Minha Conta</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* Identidade da conta + ações */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardContent className="p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-slate-50">{form.full_name || "Sem nome"}</h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{user?.email}</p>
                  <div className="flex gap-2 mt-1.5">
                    {profile?.user_type && (
                      <Badge className="bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300 text-xs capitalize">
                        {profile.user_type}
                      </Badge>
                    )}
                    {isPremiumVerified && (
                      <Badge variant="outline" className="flex items-center gap-1 border-orange-300 text-xs text-orange-700 dark:border-orange-500/40 dark:text-orange-400">
                        <ShieldCheck className="h-3 w-3 text-orange-500" /> Verificado
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Ações */}
                <div className="flex flex-wrap gap-2">
                  {editMode ? (
                    <>
                      <Button variant="outline" size="sm" onClick={handleCancel} className="rounded-card gap-1.5">
                        <X className="w-4 h-4" /> Cancelar
                      </Button>
                      <Button size="sm" onClick={handleSave} disabled={saving}
                        className="rounded-card gap-1.5 bg-orange-500 hover:bg-orange-600 text-white">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Salvar
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setEditMode(true)}
                      className="rounded-card gap-1.5 bg-orange-500 hover:bg-orange-600 text-white">
                      <Pencil className="w-4 h-4" /> Editar Perfil
                    </Button>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => logout(true)}
                    className="rounded-card gap-1.5 border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    <LogOut className="w-4 h-4" />
                    Sair da conta
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Dados pessoais — somente o responsável pela conta */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <User className="w-4 h-4 text-orange-500" /> Dados Pessoais
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="Nome Completo *" icon={User} value={form.full_name}
                  editMode={editMode} onChange={(v) => setForm({ ...form, full_name: v })} />
                <Field label="E-mail da Conta" icon={Mail} value={user?.email}
                  editMode={false} readOnly />
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Dados da empresa */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Building2 className="w-4 h-4 text-orange-500" /> Dados da Empresa
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Logo + Capa */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-500 dark:text-slate-400">{isFornecedor ? "Logo da Empresa" : "Foto de Perfil"}</Label>
                  <div className="relative w-20 h-20 rounded-card overflow-hidden bg-orange-100 dark:bg-orange-500/10 border border-slate-100 dark:border-slate-800 flex items-center justify-center">
                    {form.avatar_url ? (
                      <img src={form.avatar_url} alt="Logo da empresa" className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-2xl font-bold text-orange-500">{initials}</span>
                    )}
                    {editMode && (
                      <label className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-orange-500 flex items-center justify-center cursor-pointer shadow">
                        {uploadingAvatar ? (
                          <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                        ) : (
                          <Camera className="w-3.5 h-3.5 text-white" />
                        )}
                        <input type="file" accept="image/*" aria-label={isFornecedor ? "Trocar logo da empresa" : "Trocar foto de perfil"} className="hidden" onChange={handleAvatarUpload} />
                      </label>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-500 dark:text-slate-400">Foto de Capa</Label>
                  <div className="relative w-full h-20 rounded-card overflow-hidden">
                    {form.cover_url ? (
                      <img src={form.cover_url} alt="Capa da empresa" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-r from-orange-400 to-orange-600" />
                    )}
                    {editMode && (
                      <div className="absolute top-1.5 right-1.5 flex gap-1.5">
                        <label className="w-7 h-7 rounded-full bg-black/40 hover:bg-black/55 flex items-center justify-center cursor-pointer backdrop-blur-sm transition-colors">
                          {uploadingCover ? (
                            <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
                          ) : (
                            <Camera className="w-3.5 h-3.5 text-white" />
                          )}
                          <input type="file" accept="image/*" aria-label="Trocar foto de capa" className="hidden" onChange={handleCoverUpload} />
                        </label>
                        {form.cover_url && (
                          <button
                            type="button"
                            onClick={handleRemoveCover}
                            title="Remover capa"
                            aria-label="Remover capa"
                            className="w-7 h-7 rounded-full bg-black/40 hover:bg-black/55 flex items-center justify-center backdrop-blur-sm transition-colors"
                          >
                            <X className="w-3.5 h-3.5 text-white" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                {/* CNPJ numa linha inteira: em meia coluna o botão de
                    consulta espremia o campo. */}
                <div className="space-y-1.5 sm:col-span-2">
                  {editMode ? (
                    <>
                      <Label htmlFor="conta-cnpj" className="text-xs text-slate-500 dark:text-slate-400">CNPJ *</Label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input id="conta-cnpj" value={form.cnpj || ""}
                          onChange={(e) => setForm({ ...form, cnpj: formatCNPJ(e.target.value) })}
                          placeholder="00.000.000/0001-00" maxLength={18} autoCapitalize="characters"
                          className="h-10 min-w-0 rounded-lg text-sm sm:flex-1" />
                        <CnpjLookupButton consulta={consultaCnpj} className="h-10 rounded-lg" />
                      </div>
                    </>
                  ) : (
                    <Field label="CNPJ *" value={form.cnpj} editMode={false} />
                  )}
                  {cnpjSalvoInvalido && (form.cnpj || "") === (profile?.cnpj || "") && (
                    <p className="flex items-center gap-1 text-xs text-orange-700 dark:text-orange-400">
                      <AlertTriangle className="h-3 w-3" /> Este CNPJ parece inválido. Confira os números.
                    </p>
                  )}
                  {editMode && (
                    <CnpjLookupResult consulta={consultaCnpj} form={form}
                      onApply={(patch) => setForm((f) => ({ ...f, ...patch }))} />
                  )}
                </div>
                <Field label="Razão Social *" icon={Building2} value={form.company_name}
                  editMode={editMode} onChange={(v) => setForm({ ...form, company_name: v })}
                  placeholder="Nome da empresa" />
                <Field label="Telefone da Empresa" icon={Phone} value={form.phone}
                  editMode={editMode} onChange={(v) => setForm({ ...form, phone: v })}
                  placeholder="(11) 99999-9999" />
                {/* CEP opcional, linha inteira como o CNPJ. Não aparece no
                    perfil público (company_public_profile não o devolve). */}
                <div className="space-y-1.5 sm:col-span-2">
                  {editMode ? (
                    <>
                      <Label htmlFor="conta-cep" className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> CEP
                      </Label>
                      <div className="relative sm:max-w-[12rem]">
                        <Input id="conta-cep" value={form.cep || ""}
                          onChange={(e) => { setCepTocado(true); setForm({ ...form, cep: formatCEP(e.target.value) }); }}
                          placeholder="00000-000" maxLength={9} inputMode="numeric" autoComplete="postal-code"
                          className="h-10 rounded-lg pr-9 text-sm" />
                        <CepLookupSpinner consulta={consultaCep} />
                      </div>
                      <CepLookupResult consulta={consultaCep} form={form}
                        onApply={(patch) => setForm((f) => ({ ...f, ...patch }))} />
                    </>
                  ) : (
                    <Field label="CEP" icon={MapPin} value={form.cep} editMode={false} />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Cidade" icon={MapPin} value={form.city}
                    editMode={editMode} onChange={(v) => setForm({ ...form, city: v })}
                    placeholder="Sua cidade" />
                  {/* Lista, não texto livre: aceitava "XX" ou "S" (o cadastro
                      já usava a lista de UFs). */}
                  <div className="space-y-1.5">
                    <Label className="text-xs text-slate-500 dark:text-slate-400">UF</Label>
                    {editMode ? (
                      <Select value={form.state || undefined} onValueChange={(v) => setForm({ ...form, state: v })}>
                        <SelectTrigger className="h-10 rounded-lg text-sm"><SelectValue placeholder="UF" /></SelectTrigger>
                        <SelectContent>
                          {STATES.map((uf) => <SelectItem key={uf} value={uf}>{uf}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="h-10 px-3 flex items-center rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 text-sm text-slate-700 dark:text-slate-200">
                        {form.state || <span className="text-slate-400 italic">—</span>}
                      </div>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-500 dark:text-slate-400">Segmento</Label>
                  {editMode ? (
                    <Select value={form.segment || undefined} onValueChange={(v) => setForm({ ...form, segment: v })}>
                      <SelectTrigger className="h-10 rounded-lg text-sm">
                        <SelectValue placeholder="Selecione..." />
                      </SelectTrigger>
                      <SelectContent>
                        {segmentOptions.map((opt) => (
                          <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="h-10 px-3 flex items-center rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 text-sm text-slate-700 dark:text-slate-200">
                      {segmentLabel || <span className="text-slate-400 italic">Não informado</span>}
                    </div>
                  )}
                  {editMode && <CategoryHint category={form.segment} className="mt-0" />}
                </div>
              </div>

              {/* Descrição da empresa (não é a descrição de um anúncio). Só
                  para fornecedor: ela aparece no perfil PÚBLICO da empresa,
                  e o cliente via um cadeado "Planos Profissional e Premium"
                  com link para planos que ele nem pode contratar. */}
              {isFornecedor && <div className="space-y-1.5">
                <Label className="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2">
                  <span>Descrição da Empresa</span>
                  {!canEditDescription && (
                    <span className="inline-flex items-center gap-1 font-normal normal-case text-orange-600 dark:text-orange-400">
                      <Lock className="w-3 h-3" /> Planos Profissional e Premium
                    </span>
                  )}
                </Label>
                {editMode && canEditDescription && (
                  <Textarea
                    value={form.company_description}
                    onChange={(e) => setForm({ ...form, company_description: e.target.value })}
                    placeholder="Conte um pouco sobre a sua empresa..."
                    className="rounded-lg text-sm min-h-[96px]"
                  />
                )}
                {editMode && !canEditDescription && (
                  <div className="space-y-1.5 rounded-card border border-dashed border-orange-300 bg-orange-50 px-3 py-3 text-xs text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-300">
                    <p>Disponível nos planos Profissional e Premium.</p>
                    <Link to={`${createPageUrl("Planos")}?onboarding=1`} className="font-semibold underline">
                      Ver planos
                    </Link>
                  </div>
                )}
                {!editMode && (
                  <div className="min-h-10 px-3 py-2.5 flex items-center rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 text-sm text-slate-700 dark:text-slate-200">
                    {form.company_description || <span className="text-slate-400 italic">Não informado</span>}
                  </div>
                )}
              </div>}
            </CardContent>
          </Card>
        </motion.div>

        {/* Acesso rápido */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <Card className="rounded-card border border-slate-200 shadow-none dark:border-slate-800">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Acesso Rápido</CardTitle>
            </CardHeader>
            <CardContent>
              <Link to={createPageUrl("Configuracoes")}>
                <div className="flex items-center gap-3 p-4 rounded-card border border-slate-100 dark:border-slate-800 hover:border-orange-200 dark:hover:border-orange-900/50 hover:bg-orange-50 dark:hover:bg-orange-500/10 transition-all cursor-pointer">
                  <div className="w-10 h-10 rounded-card bg-orange-100 dark:bg-orange-500/10 flex items-center justify-center">
                    <Settings className="w-5 h-5 text-orange-500" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">Configurações</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Preferências, segurança, privacidade e suporte</p>
                  </div>
                </div>
              </Link>
            </CardContent>
          </Card>
        </motion.div>

      </div>
    </div>
  );
}

// Componente auxiliar de campo
function Field({ label, icon: Icon, value, editMode, onChange, placeholder, readOnly }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </Label>
      {editMode && !readOnly ? (
        <Input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-10 rounded-lg text-sm"
        />
      ) : (
        <div className="h-10 px-3 flex items-center rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800 text-sm text-slate-700 dark:text-slate-200">
          {value || <span className="text-slate-400 italic">Não informado</span>}
        </div>
      )}
    </div>
  );
}