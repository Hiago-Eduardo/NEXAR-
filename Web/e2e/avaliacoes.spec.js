import { test, expect, temCredencial, entrar } from './helpers.js';

/**
 * Avaliações -- a regressão das seções 97 a 104.
 *
 * Este arquivo é o que teria evitado três rodadas de idas e vindas. O bug do
 * `applyFilters` (seção 104) fazia a lista de avaliações chegar vazia enquanto
 * a NOTA do anúncio aparecia normal, porque a nota vem de `supplier.rating` e
 * não das avaliações. O teste abaixo verifica exatamente essa combinação.
 */
const ANUNCIO_COM_AVALIACAO = 'c01db954-096d-4cac-8aec-bfad32eb8283';

test.describe('avaliações na página do anúncio', () => {
  test('mostra o TEXTO e o AUTOR, não só a nota (seção 104)', async ({ page }) => {
    await page.goto(`/SupplierProfile?id=${ANUNCIO_COM_AVALIACAO}`);

    // Asserção pelo CONTEÚDO, não pela estrutura: o sintoma do bug era a nota
    // aparecer e a lista ficar vazia, então é o autor e o comentário que
    // precisam estar na tela. Amarrar num <section> só tornaria o teste
    // frágil a mudança de marcação (foi o que me fez errar na primeira versão:
    // o <h2> do painel contém o título E o contador, então `exact: true` nunca
    // casava).
    await expect(page.getByText('tester', { exact: true })).toBeVisible();
    await expect(page.getByText(/teste de aval/i)).toBeVisible();

    await expect(page.getByText('Nenhuma avaliação ainda')).toHaveCount(0);
    // E o erro nunca mais pode se disfarçar de "não há avaliações".
    await expect(page.getByText(/Não foi possível carregar as avaliações/)).toHaveCount(0);
  });

  test('o formulário de avaliação não aparece para quem não tem conta (seção 97)', async ({
    page,
  }) => {
    await page.goto(`/SupplierProfile?id=${ANUNCIO_COM_AVALIACAO}`);
    // Antes, o formulário aparecia e o envio falhava em silêncio (a policy de
    // insert é `to authenticated`).
    await expect(page.getByRole('button', { name: /Enviar Avaliação/i })).toHaveCount(0);
    await expect(page.getByText(/Crie sua conta gratuita para avaliar/i)).toBeVisible();
  });
});

test.describe('avaliações para o fornecedor', () => {
  test.skip(!temCredencial('fornecedor'), 'defina TEST_FORNECEDOR_* no .env.local');

  test('o Dashboard mostra as avaliações recebidas com texto (seção 102)', async ({ page }) => {
    await entrar(page, 'fornecedor');
    await page.goto('/Dashboard');

    // A seção só existe se a conta TIVER anúncio com avaliação -- e a conta de
    // teste atual (testerclaude) nasceu vazia. Sem este pulo, o teste falha
    // por falta de DADO e não por defeito, que é o pior tipo de vermelho:
    // some a distinção entre "quebrou" e "não havia o que mostrar" (seção 128).
    //
    // O pulo olha o ESTADO VAZIO DOS ANÚNCIOS, não a ausência do painel de
    // avaliações: decidir pular por "o painel não está lá" tornaria o teste
    // incapaz de pegar o próprio bug que ele existe para pegar -- ele passaria
    // justamente quando o painel sumisse.
    //
    // O botão "Criar Primeiro Anúncio" só é renderizado quando
    // suppliers.length === 0 (Dashboard.jsx), então é um sinal exato de "esta
    // conta não tem anúncio", e não uma heurística. A primeira versão desta
    // sonda contava links por nome acessível e dava sempre zero, porque os
    // botões de editar são só ícones -- o teste pulava mesmo com dados na
    // tela (seção 129).
    // Espera a lista de anúncios CHEGAR antes de decidir. `count()` não
    // espera, e os anúncios vêm de uma query assíncrona -- sem o waitFor, a
    // sonda respondia "tem anúncio" para uma conta vazia e o teste falhava em
    // vez de pular. Foi exatamente isso que apareceu ao rodar `npm run
    // seed:limpar` e repetir a suíte (seção 129).
    //
    // Espera por QUALQUER UM dos dois desfechos possíveis da carga -- o
    // estado vazio ou o painel -- em vez de um sleep fixo.
    const vazio = page.getByRole('link', { name: /Criar Primeiro Anúncio/i });
    const painel = page.locator('text=Avaliações Recebidas');
    await Promise.race([
      vazio.first().waitFor({ timeout: 10000 }).catch(() => {}),
      painel.first().waitFor({ timeout: 10000 }).catch(() => {}),
    ]);

    if ((await vazio.count()) > 0) {
      test.skip(true, 'conta de teste não tem anúncio -- rode `npm run seed`');
    }

    // O painel mostrava só contagem e média; não havia onde LER a avaliação.
    await expect(painel).toBeVisible();
  });

  // ESTE TESTE ESCREVE. Por isso é opt-in, e não roda no `npm run e2e` normal.
  //
  // Ele envia uma avaliação de verdade pelo formulário. A intenção é provar
  // que o trigger enforce_review_rules recusa a auto-avaliação -- e, se o
  // fornecedor logado for mesmo o dono do anúncio, nada é gravado. MAS o
  // formulário aparece para QUALQUER usuário logado: se a conta de teste não
  // for dona deste anúncio, o envio dá certo e deixa uma avaliação 5 estrelas
  // órfã no banco, inflando a reputação de um fornecedor real.
  //
  // O `if (count === 0) skip` da primeira versão NÃO protegia contra isso --
  // ele só detecta o formulário ausente, que é o caso do visitante deslogado.
  //
  // Para rodar de propósito, com uma conta que você sabe ser dona do anúncio:
  //   E2E_ALLOW_WRITES=1 npm run e2e
  // Quando o script de seed existir, ele criará um anúncio de dono conhecido e
  // este teste deixa de precisar do portão.
  test('o fornecedor não consegue avaliar o próprio anúncio (seção 97)', async ({ page }) => {
    test.skip(
      process.env.E2E_ALLOW_WRITES !== '1',
      'teste que ESCREVE no banco -- rode com E2E_ALLOW_WRITES=1 e conta dona do anúncio'
    );

    await entrar(page, 'fornecedor');
    await page.goto(`/SupplierProfile?id=${ANUNCIO_COM_AVALIACAO}`);

    const enviar = page.getByRole('button', { name: /Enviar Avaliação/i });
    await expect(enviar).toBeVisible();

    // 5 estrelas e enviar.
    await page.locator('button:has(svg)').filter({ hasText: '' }).nth(4).click();
    await enviar.click();

    // O trigger enforce_review_rules recusa, e a mensagem chega traduzida.
    await expect(page.getByText(/não pode avaliar o seu próprio anúncio/i)).toBeVisible();
    // Se isto falhar, a avaliação FOI gravada: apague a linha em `reviews`.
    await expect(page.getByText('Avaliação enviada!')).toHaveCount(0);
  });
});
