-- NEXAR -- fecha o insert direto em contact_requests (Resumo.md §228).
-- PREPARADO, NÃO RODADO. É O ÚLTIMO PASSO -- rodar fora de ordem quebra o
-- formulário de orçamento para todo mundo.
--
-- Ordem:
--   1. contact-request-captcha.sql (RPC submit_contact_request);
--   2. deploy da Edge Function submit-contact-request + secret
--      TURNSTILE_SECRET_KEY (e TURNSTILE_ALLOWED_HOSTNAMES, ALLOWED_ORIGINS);
--   3. VITE_TURNSTILE_CONTACT_REQUIRED=true no build do site, publicado, e um
--      pedido de teste passando pela função;
--   4. ESTE arquivo.
--
-- Depois dele, o único jeito de criar pedido de orçamento é a Edge Function
-- (que exige o CAPTCHA). Sem isto, a função seria só um validador que
-- qualquer um contorna mandando o insert direto para o PostgREST.
--
-- Leitura, atualização de status (set_contact_request_status) e as demais
-- policies NÃO mudam. A policy de insert fica no banco, mas sem o privilégio
-- INSERT ela não tem efeito para o cliente. Scripts que inserem pedido direto
-- com a chave pública (ex.: o teste de orçamento do §226) param de funcionar
-- -- é o objetivo.
--
-- Desfazer: grant insert on public.contact_requests to authenticated;

revoke insert on public.contact_requests from anon, authenticated;

-- Conferência (leitura):
--   select has_table_privilege('authenticated', 'public.contact_requests', 'insert'); -- false
--   select has_table_privilege('authenticated', 'public.contact_requests', 'select'); -- true
