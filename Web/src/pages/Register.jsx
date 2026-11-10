import React, { useState } from "react";
import { api, supabase } from "@/api/client";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft, ArrowRight, Loader2, CheckCircle, Store, User, Info, Mail
} from "lucide-react";
import { PasswordInput, PasswordRequirements } from "@/components/shared/PasswordInput";
import { MIN_PASSWORD_LENGTH, passwordError } from "@/lib/password";
import { Link, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { authErrorMessage, safeReturnPath } from "@/lib/authErrors";
import { isValidCNPJ, formatCNPJ } from "@/lib/cnpj";
import { useCnpjLookup, CnpjLookupButton, CnpjLookupResult } from "@/components/shared/CnpjLookup";
import { useCepLookup, CepLookupSpinner, CepLookupResult } from "@/components/shared/CepLookup";
import { formatCEP, isValidCEP, cepForStorage, saveWithOptionalCep } from "@/lib/cep";
import { CATEGORIES } from "@/lib/categories";
import CategoryHint from "@/components/shared/CategoryHint";
import { buildSignupMetadata, confirmRedirectUrl, isExistingAccountSignup } from "@/lib/signup";
import ResendConfirmation from "@/components/shared/ResendConfirmation";
import { useCaptcha } from "@/components/shared/Turnstile";
import Footer from "../components/shared/Footer";

const states = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

const ROTULO = "text-sm font-medium text-slate-700 dark:text-slate-200";

export default function Register() {
  const [searchParams] = useSearchParams();
  // Página protegida que mandou o visitante para cá (via Login). Cliente
  // volta para ela depois do cadastro; fornecedor vai antes escolher o plano.
  const from = safeReturnPath(searchParams.get("from"), window.location.origin);

  const [step, setStep] = useState(1); // 1: tipo, 2: dados
  const [userType, setUserType] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // E-mail para o qual o link de confirmação foi enviado: mostra a tela
  // "Verifique seu e-mail" (seção 208).
  const [verificacaoPendente, setVerificacaoPendente] = useState("");
  // A conta de login já foi criada numa tentativa anterior e o que falhou foi
  // o perfil. Sem isto, a nova tentativa chamava signUp de novo e recebia
  // "já existe uma conta com este e-mail" -- a pessoa ficava com uma conta
  // sem perfil e sem como concluir o cadastro.
  const [accountCreated, setAccountCreated] = useState(false);
  // Turnstile no signUp (§228). Só vale para criar a conta: a nova tentativa
  // de salvar o perfil (accountCreated) não chama o Auth.
  const captcha = useCaptcha({ action: "signup" });

  const [profileForm, setProfileForm] = useState({
    full_name: "", cnpj: "", company_name: "", email: "", phone: "", cep: "", city: "", state: "", segment: ""
  });
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");

  const handleProfileChange = (field, value) => setProfileForm((p) => ({ ...p, [field]: value }));
  // Consulta antes do login: vai do navegador do visitante direto à
  // BrasilAPI (dados públicos), e nada é gravado até Finalizar Cadastro.
  // Automática aqui (e só aqui): no cadastro os campos estão vazios e quem
  // digita o CNPJ quer os dados da empresa. Em Minha Conta fica no botão.
  const consultaCnpj = useCnpjLookup(profileForm.cnpj, { auto: true });
  // CEP: mesma regra -- automático no cadastro, só mostra; preencher cidade
  // e UF é escolha da pessoa, sem passar por cima do que veio do CNPJ.
  const consultaCep = useCepLookup(profileForm.cep, { auto: true });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError("");

    // Validação local fora do try: não é falha do sistema, não vai para o
    // console como erro.
    // Regra única de senha nova (src/lib/password.js, seção 176).
    const senhaFraca = passwordError(password);
    if (senhaFraca) {
      setSubmitError(senhaFraca);
      return;
    }
    if (password !== passwordConfirmation) {
      setSubmitError("As senhas não conferem.");
      return;
    }
    if (!isValidCNPJ(profileForm.cnpj)) {
      setSubmitError("CNPJ inválido. Confira os números: os dois últimos dígitos não batem com o resto.");
      return;
    }
    // CEP é opcional, mas começado tem de estar completo.
    if (profileForm.cep && !isValidCEP(profileForm.cep)) {
      setSubmitError("CEP incompleto. Digite os 8 números ou deixe o campo vazio.");
      return;
    }

    if (!accountCreated && !captcha.canSubmit) {
      setSubmitError("Conclua a verificação de segurança para criar a conta.");
      return;
    }

    setSaving(true);
    // Local e não o estado `accountCreated`: dentro deste handler o estado
    // ainda tem o valor de antes do clique, e a mensagem de "conta criada,
    // falta o perfil" nunca aparecia na primeira falha.
    let contaExiste = accountCreated;
    try {
      const accountEmail = profileForm.email.trim().toLowerCase();
      // CEP só com dígitos e só quando preenchido (é opcional).
      const cepGravado = cepForStorage(profileForm.cep);

      if (!contaExiste) {
        // Os dados do perfil vão nos metadados: com a confirmação de e-mail
        // ligada não há sessão aqui, e quem cria user_profiles é o trigger
        // nexar_create_profile_on_signup (supabase/signup-profile-trigger.sql).
        // A foto saiu do cadastro -- o envio exige sessão; vai em Minha Conta.
        const { data: authData, error: authError } = await supabase.auth.signUp({
          email: accountEmail,
          password,
          options: {
            captchaToken: captcha.consume(),
            data: buildSignupMetadata({ ...profileForm, cep: cepGravado || "" }, userType),
            emailRedirectTo: confirmRedirectUrl(window.location.origin, from),
          },
        });
        if (authError) throw authError;
        // E-mail já cadastrado: o Supabase não dá erro (não revela quem tem
        // conta) e devolve um usuário sem identidades, sem mandar e-mail.
        if (isExistingAccountSignup(authData)) {
          setSubmitError(authErrorMessage({ code: "user_already_exists" }));
          return;
        }
        if (!authData.session) {
          // O caminho normal com "Confirm email" ligado: a conta só entra
          // depois do link. Quem barra o acesso é o Supabase Auth.
          setVerificacaoPendente(accountEmail);
          return;
        }
        setAccountCreated(true);
        contaExiste = true;
      }

      // Só chega aqui se o Supabase der sessão no cadastro (confirmação
      // desligada no painel). O trigger já criou o perfil; se ele não
      // estiver instalado, cria pelo cliente como antes.
      const { data: { user: contaNova } } = await supabase.auth.getUser();
      const existentes = contaNova ? await api.entities.UserProfile.filter({ created_by: contaNova.id }) : [];
      if (!existentes.length) {
        const { cep: _cep, ...dadosPerfil } = profileForm;
        await saveWithOptionalCep((data) => api.entities.UserProfile.create(data), {
          ...dadosPerfil,
          ...(cepGravado ? { cep: cepGravado } : {}),
          email: accountEmail,
          user_type: userType,
        });
      }

      if (userType === "fornecedor") {
        window.location.href = `${createPageUrl("Planos")}?onboarding=1`;
        return;
      }

      setSaved(true);
    } catch (error) {
      console.error("Registration failed:", error);
      const mensagem = authErrorMessage(error, "Não foi possível concluir o cadastro.");
      setSubmitError(
        contaExiste
          ? `Sua conta foi criada, mas o perfil não foi salvo. ${mensagem} Clique em Finalizar Cadastro de novo.`
          : mensagem
      );
    } finally {
      setSaving(false);
    }
  };

  if (verificacaoPendente) {
    const loginUrl = from ? `${createPageUrl("Login")}?from=${encodeURIComponent(from)}` : createPageUrl("Login");
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 py-12 dark:bg-slate-950">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
          <Card className="rounded-card border border-slate-200 shadow-sm dark:border-slate-800">
            <CardContent className="space-y-5 p-8 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-orange-50 dark:bg-orange-500/10">
                <Mail className="h-8 w-8 text-orange-500" />
              </div>
              <div className="space-y-2">
                <h2 className="font-display text-2xl font-black text-slate-900 dark:text-slate-50">Verifique seu e-mail</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Enviamos um link de confirmação para{" "}
                  <strong className="text-slate-800 dark:text-slate-100">{verificacaoPendente}</strong>.
                  Clique nele para ativar sua conta. Sem a confirmação não é possível entrar.
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Não chegou em alguns minutos? Confira a caixa de spam ou peça outro link.
                </p>
              </div>
              <ResendConfirmation email={verificacaoPendente} from={from} startCooldown />
              <div className="flex flex-col gap-2 pt-1 text-sm">
                <Link to={loginUrl} className="font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400">
                  Já confirmei — Entrar
                </Link>
                <button type="button" onClick={() => setVerificacaoPendente("")}
                  className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                  Digitei o e-mail errado
                </button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  if (saved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 dark:bg-slate-950">
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="text-center max-w-md">
          {/* Verde de propósito: confirmação semântica real, mesma regra de
              ReviewForm.jsx e AdEditor.jsx (seção 71). Não é uma segunda cor
              de destaque -- é o único uso de verde que o sistema permite. */}
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/10">
            <CheckCircle className="h-10 w-10 text-emerald-500" />
          </div>
          <h2 className="mb-3 font-display text-2xl font-black text-slate-900 dark:text-slate-50">Cadastro realizado!</h2>
          <p className="text-slate-500 dark:text-slate-400 mb-8">
            Sua conta de cliente foi criada. Explore os fornecedores disponíveis!
          </p>
          <Link to={from || createPageUrl("Suppliers")}>
            <Button className="rounded-card bg-orange-500 hover:bg-orange-600">
              {from ? "Continuar de onde parei" : "Ver Fornecedores"}
            </Button>
          </Link>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <Link to={createPageUrl("Home")}>
          <Button variant="ghost" className="mb-6 -ml-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
            <ArrowLeft className="w-4 h-4 mr-2" />Voltar ao início
          </Button>
        </Link>

        <div className="mb-8">
          <h1 className="font-display text-3xl font-black tracking-tight text-slate-900 dark:text-slate-50 md:text-4xl">Criar Conta</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-1">
            Preencha os dados para se cadastrar na plataforma.{" "}
            {/* Não havia caminho daqui para o login -- e até a seção 161 era
                para cá que as páginas protegidas mandavam quem já tinha conta. */}
            Já tem conta?{" "}
            <Link
              to={from ? `${createPageUrl("Login")}?from=${encodeURIComponent(from)}` : createPageUrl("Login")}
              className="font-semibold text-orange-600 hover:text-orange-700 dark:text-orange-400"
            >
              Entrar
            </Link>
          </p>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2].map((s) => (
            <React.Fragment key={s}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                step >= s ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500"
              }`}>{s}</div>
              {s < 2 && (
                <div className={`flex-1 h-1 rounded-full ${step > s ? "bg-orange-500" : "bg-slate-200 dark:bg-slate-800"}`} />
              )}
            </React.Fragment>
          ))}
          <span className="ml-3 text-sm text-slate-400 dark:text-slate-500">
            {step === 1 ? "Tipo de conta" : "Dados pessoais e empresa"}
          </span>
        </div>

        <form onSubmit={handleSubmit}>
          <AnimatePresence mode="wait">
            {/* Step 1: Tipo */}
            {step === 1 && (
              <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                <Card className="rounded-card border border-slate-200 shadow-sm dark:border-slate-800">
                  <CardContent className="p-8">
                    <h2 className="mb-6 font-display text-lg font-extrabold text-slate-900 dark:text-slate-50">Qual é o seu perfil?</h2>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <button
                        type="button"
                        onClick={() => setUserType("cliente")}
                        aria-pressed={userType === "cliente"}
                        className={`rounded-card border-2 p-6 text-left transition-all ${
                          userType === "cliente" ? "border-orange-500 bg-orange-50 dark:bg-orange-500/10" : "border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700"
                        }`}
                      >
                        <User className={`w-10 h-10 mb-4 ${userType === "cliente" ? "text-orange-500" : "text-slate-300 dark:text-slate-600"}`} />
                        <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">Cliente / Empreendedor</h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">Busco fornecedores para o meu negócio</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => setUserType("fornecedor")}
                        aria-pressed={userType === "fornecedor"}
                        className={`rounded-card border-2 p-6 text-left transition-all ${
                          userType === "fornecedor" ? "border-orange-500 bg-orange-50 dark:bg-orange-500/10" : "border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700"
                        }`}
                      >
                        <Store className={`w-10 h-10 mb-4 ${userType === "fornecedor" ? "text-orange-500" : "text-slate-300 dark:text-slate-600"}`} />
                        <h3 className="font-bold text-slate-800 dark:text-slate-100 mb-1">Fornecedor</h3>
                        <p className="text-sm text-slate-500 dark:text-slate-400">Ofereço produtos ou serviços para empresas</p>
                      </button>
                    </div>

                    {/* Ícone do sistema no lugar do emoji ⚠️ (seção 175). */}
                    <div className="mt-4 flex items-start gap-2.5 rounded-card border border-orange-200 bg-orange-50 p-4 text-sm text-orange-900 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-200">
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" aria-hidden="true" />
                      <p>CNPJ é obrigatório para todos os perfis da plataforma.</p>
                    </div>

                    <Button
                      type="button"
                      disabled={!userType}
                      onClick={() => setStep(2)}
                      className="w-full mt-6 h-12 rounded-card bg-orange-500 hover:bg-orange-600 text-white"
                    >
                      Continuar <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            )}

            {/* Step 2: Dados pessoais */}
            {step === 2 && (
              <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-4">
                <Card className="rounded-card border border-slate-200 shadow-sm dark:border-slate-800">
                  <CardContent className="p-8 space-y-5">
                    <h2 className="font-display text-lg font-extrabold text-slate-900 dark:text-slate-50">Dados Pessoais e Empresa</h2>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="reg-nome" className={ROTULO}>Nome Completo *</Label>
                        <Input id="reg-nome" required autoComplete="name" value={profileForm.full_name} onChange={(e) => handleProfileChange("full_name", e.target.value)} placeholder="Seu nome" className="mt-1.5 h-11 rounded-card" />
                      </div>
                      <div>
                        <Label htmlFor="reg-email" className={ROTULO}>Email *</Label>
                        {/* Depois de criada a conta, o e-mail não muda mais: a
                            nova tentativa grava só o perfil, e ele tem de
                            continuar batendo com a conta de login. */}
                        <Input id="reg-email" required type="email" autoComplete="email" disabled={accountCreated} value={profileForm.email} onChange={(e) => handleProfileChange("email", e.target.value)} placeholder="email@empresa.com" className="mt-1.5 h-11 rounded-card" />
                      </div>
                    </div>

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="reg-senha" className={ROTULO}>Senha *</Label>
                        <PasswordInput id="reg-senha" required autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} disabled={accountCreated} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres`} aria-describedby="reg-senha-regras" className="mt-1.5 h-11 rounded-card" />
                        {!accountCreated && <PasswordRequirements id="reg-senha-regras" senha={password} />}
                      </div>
                      <div>
                        <Label htmlFor="reg-senha2" className={ROTULO}>Confirmar senha *</Label>
                        <PasswordInput id="reg-senha2" required autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} disabled={accountCreated} value={passwordConfirmation} onChange={(e) => setPasswordConfirmation(e.target.value)} placeholder="Repita sua senha" className="mt-1.5 h-11 rounded-card" />
                        {!accountCreated && passwordConfirmation.length > 0 && passwordConfirmation !== password && (
                          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">As senhas não conferem.</p>
                        )}
                      </div>
                    </div>

                    {/* Uma linha cada: o botão "Consultar CNPJ" espremia o
                        campo em meia coluna. */}
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="reg-cnpj" className={ROTULO}>CNPJ *</Label>
                        {/* Sem inputMode numérico: o CNPJ de 2026 aceita letras. */}
                        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
                          <Input
                            id="reg-cnpj"
                            required
                            autoCapitalize="characters"
                            value={profileForm.cnpj}
                            onChange={(e) => handleProfileChange("cnpj", formatCNPJ(e.target.value))}
                            placeholder="00.000.000/0000-00"
                            maxLength={18}
                            className="h-11 min-w-0 rounded-card sm:flex-1"
                          />
                          <CnpjLookupButton consulta={consultaCnpj} />
                        </div>
                      </div>
                      <div>
                        <Label htmlFor="reg-razao" className={ROTULO}>Razão Social *</Label>
                        <Input id="reg-razao" required autoComplete="organization" value={profileForm.company_name} onChange={(e) => handleProfileChange("company_name", e.target.value)} placeholder="Nome empresarial" className="mt-1.5 h-11 rounded-card" />
                      </div>
                    </div>

                    <CnpjLookupResult
                      consulta={consultaCnpj}
                      form={profileForm}
                      onApply={(patch) => setProfileForm((p) => ({ ...p, ...patch }))}
                    />

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="reg-tel" className={ROTULO}>Telefone</Label>
                        <Input id="reg-tel" type="tel" autoComplete="tel" value={profileForm.phone} onChange={(e) => handleProfileChange("phone", e.target.value)} placeholder="(00) 00000-0000" className="mt-1.5 h-11 rounded-card" />
                      </div>
                      <div>
                        <Label className={ROTULO}>Segmento</Label>
                        {/* Lista de categorias, não texto livre: a Conta edita o
                            segmento pela mesma lista e mostrava o que foi
                            digitado aqui como "(valor atual)" (seção 165). */}
                        <Select value={profileForm.segment || undefined} onValueChange={(v) => handleProfileChange("segment", v)}>
                          <SelectTrigger className="mt-1.5 h-11 rounded-card"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                          <SelectContent>
                            {CATEGORIES.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <CategoryHint category={profileForm.segment} />
                      </div>
                    </div>

                    {/* CEP opcional: só ajuda a preencher cidade e UF. Rua e
                        bairro aparecem no painel e não são salvos. */}
                    <div>
                      <Label htmlFor="reg-cep" className={ROTULO}>CEP</Label>
                      {/* Sem botão: consulta sozinha ao completar os 8
                          dígitos (seção 206). Campo na largura de um CEP. */}
                      <div className="relative mt-1.5 sm:max-w-[12rem]">
                        <Input
                          id="reg-cep"
                          inputMode="numeric"
                          autoComplete="postal-code"
                          value={profileForm.cep}
                          onChange={(e) => handleProfileChange("cep", formatCEP(e.target.value))}
                          placeholder="00000-000"
                          maxLength={9}
                          className="h-11 rounded-card pr-9"
                        />
                        <CepLookupSpinner consulta={consultaCep} />
                      </div>
                    </div>

                    <CepLookupResult
                      consulta={consultaCep}
                      form={profileForm}
                      onApply={(patch) => setProfileForm((p) => ({ ...p, ...patch }))}
                    />

                    <div className="grid sm:grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="reg-cidade" className={ROTULO}>Cidade</Label>
                        <Input id="reg-cidade" autoComplete="address-level2" value={profileForm.city} onChange={(e) => handleProfileChange("city", e.target.value)} placeholder="Sua cidade" className="mt-1.5 h-11 rounded-card" />
                      </div>
                      <div>
                        <Label className={ROTULO}>Estado</Label>
                        <Select value={profileForm.state} onValueChange={(v) => handleProfileChange("state", v)}>
                          <SelectTrigger className="mt-1.5 h-11 rounded-card"><SelectValue placeholder="UF" /></SelectTrigger>
                          <SelectContent>
                            {states.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {!accountCreated && captcha.widget}

                    {/* Erro junto dos botões: antes ficava entre a senha e o
                        CNPJ, longe de onde a pessoa acabou de clicar. */}
                    {submitError && (
                      <div role="alert" className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-500/10 dark:text-red-400">
                        {submitError}
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={accountCreated} className="flex-1 h-11 rounded-card">
                        <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
                      </Button>
                      <Button type="submit" disabled={saving || (!accountCreated && !captcha.canSubmit)} className="flex-1 h-11 rounded-card bg-orange-500 hover:bg-orange-600 text-white">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Finalizar Cadastro"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            )}

          </AnimatePresence>
        </form>
      </div>
      <Footer />
    </div>
  );
}
