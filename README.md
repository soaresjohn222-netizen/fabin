# Fabinho Motors

Nova instalação independente em https://oficinafabin-nova.sillytuna64.chatgpt.site, preparada a partir de https://github.com/treedbkp-art/oficinafabin. Banco e arquivos da instalação original não são copiados.

## Acesso à nova instalação

O endereço abre diretamente o formulário de login. A conta única é configurada pelos segredos `ADMIN_USERNAME` e `ADMIN_PASSWORD_HASH`; o hash usa o scrypt do projeto. `APP_ORIGIN` contém a origem HTTPS exata. Não há etapa nem endpoint de ativação. Credenciais não devem ser incluídas no Git ou em arquivos públicos.

O esquema de credenciais da versão inicial foi preservado, sem alterar migrations aplicadas. A configuração por ambiente tem prioridade. Dados e credenciais não fazem parte dos arquivos de exportação do código.

Para clonar e configurar este repositório, consulte [GUIA-GITHUB.md](GUIA-GITHUB.md). A identificação da versão está em [VERSAO.txt](VERSAO.txt).

Aplicação em português para uma oficina de motocicletas com um operador.

## Fluxos disponíveis

- Conta única por usuário e senha, sessão de 12 horas e encerramento de sessão.
- Painel por dia, semana (segunda a domingo), mês, ano, intervalo e todo o histórico.
- Cadastro automático de cliente e moto na abertura da ordem.
- Cadastros separados de clientes e motos; placa normalizada e única.
- Histórico da moto e do cliente, com quilometragem, datas, serviços, peças, valores e observações.
- Edição de atendimento, proteção contra sobrescrita concorrente e cancelamento sem apagar o histórico.
- Exportação CSV do histórico filtrado e cópia JSON completa dos registros.
- Recebimento e download protegido das planilhas Excel originais.
- Gastos pessoais e profissionais em uma seção, com cadastro, edição, cancelamento e restauração.
- Dashboard principal com entradas, saídas e saldo por período, comparação mensal e composição dos gastos pessoais e profissionais.
- Envio de ordem em imagem pelo WhatsApp: prévia, compartilhamento nativo quando disponível e download para anexar na conversa do cliente. Ordens longas são divididas em imagens numeradas.

## Resumo financeiro

As entradas somam os valores conhecidos de ordens concluídas e registros históricos pela data do atendimento. Ordens abertas, em serviço ou canceladas ficam fora. As saídas somam todos os gastos ativos do mesmo período, incluindo os que aguardam classificação. O saldo é entradas menos saídas; pode ser negativo. Totais e série mensal usam centavos inteiros e o mesmo intervalo de datas, independentemente dos filtros de situação ou de cliente da lista de ordens.

Valores ausentes permanecem sinalizados e não são estimados. Registros com apenas o mês informado só entram quando o período contém o mês inteiro; os parcialmente abrangidos são indicados. Esses números representam valores registrados: as planilhas não confirmam recebimentos ou pagamentos, e o saldo não é apresentado como saldo bancário ou lucro.

## Correção de placas e composição das entradas

A placa pode ser corrigida diretamente em Editar atendimento. A alteração atualiza a ordem e o cadastro da mesma moto em uma operação atômica, com auditoria, verificação de placa duplicada e controle de revisão. A busca pela placa atual também encontra as visitas antigas ligadas à moto, preservando os retratos anteriores. Em Motos e placas, o botão Editar fica visível e a busca passa a mostrar a placa salva.

Os itens de novas ordens aceitam Mão de obra, Produtos e peças e Outros itens. O formulário e os detalhes mostram os subtotais e o total abaixo. No dashboard, as entradas seguem o mesmo período e as mesmas situações do total: somente concluídas e histórico, com total conhecido. Quantidade × preço determina o valor de cada item novo. No Excel, são usados os campos de mão de obra e peças preservados. Valores sem discriminação ficam em Sem detalhamento, e diferenças entre componentes e total aparecem separadamente, sem serem classificadas como Outros itens. A soma dessas parcelas reconcilia com o total informado.

`node tests/plate-income.mjs` verifica correção de placa, histórico, duplicidades, alterações simultâneas, proteção de acesso e a composição financeira, incluindo omissões e divergências das planilhas.

## Gastos e importação

Os gastos são persistidos em `expenses`, com valores em centavos, revisões, trilha de alterações e cancelamento sem exclusão. As rotas usam a mesma sessão e proteção de origem do restante do sistema. Os filtros de gastos não herdam a situação das ordens de serviço.

`scripts/prepare-expenses.py ORIGINAIS MANIFESTOS [--cache RAW_JSON]` lê as colunas Q (descrição) e S (valor) de todas as abas mensais, inclusive valores com descrição vazia. Valores ausentes ou não interpretáveis ficam nulos. Lançamentos que representam apenas um total mensal ficam identificados, sem detalhamento inventado. Resumos de outras colunas são preservados para conferência, sem somar novamente os mesmos gastos. Fórmulas, valores armazenados e células Q/S ficam preservados em cada origem.

As planilhas não informam o dia de cada gasto. O mês é referência documental, com limites inclusivos: um filtro de dia ou semana não atribui todos os gastos ao primeiro dia do mês. Gastos mensais parcialmente abrangidos são omitidos da soma e indicados na interface. Classificação automática usa apenas descrições explícitas de casa, oficina e MEI; os demais ficam `unclassified`, já incluídos no total e disponíveis para conferência manual. Nenhuma categoria é inferida a partir de nome de fornecedor.

`POST /api/imports/:id/expenses/prepare` valida o manifesto `oficina-expenses-v1` contra o arquivo original por nome e SHA-256 e guarda a preparação imutável em R2. `POST /api/imports/:id/expenses/commit` importa até 30 registros em um batch transacional. A combinação arquivo/aba/linha é única; repetições são idempotentes. `expense_imports` registra a reconciliação e o progresso. Essas operações não alteram clientes, motos ou ordens. O cliente `scripts/import-expenses.py MANIFESTOS --import` usa credenciais apenas de variáveis do processo, cria uma cópia privada antes da carga e compara os registros salvos. Não guardar esses arquivos de dados no Git.

O formulário permite corrigir o valor e o tipo de um gasto importado, mantendo as células originais imutáveis. A cópia JSON completa também inclui gastos e seus relatórios de importação. O painel informa valores registrados, sem calcular lucro ou presumir recebimento/pagamento de serviços.

## Estado da migração do Excel

O importador foi adaptado às fichas de orçamento de 2018–2026. `scripts/prepare-history.py` lê `.xlsx` com openpyxl sem modificar os originais e produz manifestos privados. Use `python scripts/prepare-history.py DIRETORIO_ORIGINAIS DIRETORIO_MANIFESTOS`. Nunca guarde planilhas, manifestos ou dados de clientes no Git.

O upload guarda bytes e SHA-256 em R2 e D1; não cria atendimentos. Depois da conferência, `POST /api/imports/:id/prepare` valida um manifesto `oficina-excel-v1` contra o hash do original e guarda o conteúdo imutável em R2. `POST /api/imports/:id/commit` recebe `{offset}` e importa até dez fichas em um `batch` transacional. O progresso é contado no banco. Repetições não duplicam fichas; a origem arquivo/aba/linha é única. Preparação, importação e downloads exigem a mesma sessão e proteção de origem das demais rotas. Nada é carregado por migrations de esquema.

As fichas importadas usam a situação `historic`: não confirmam conclusão ou pagamento. Quantidades e a coluna VALOR são preservadas literalmente, sem supor preço unitário. Peças, mão de obra, total geral, fórmulas, valores armazenados e células originais ficam disponíveis em cada ficha. Total ausente não vira zero na interface ou no CSV. Valores isolados em fichas vazias, despesas e resumos mensais ficam no relatório, sem criar atendimentos ou duplicar entradas financeiras. Abas auxiliares permanecem no arquivo original. Divergências entre resumos e somas ficam sinalizadas.

Data exata só é usada quando válida e coerente com o ano do arquivo e o mês da aba. Nas demais fichas, o período mensal é referência documental, com `date_precision=month` e limites inclusivos do mês. Consultas por dia/semana não atribuem essas fichas a um dia inventado: indicam quantas foram omitidas e orientam consultar o mês inteiro. A ação Conferir data registra motivo, revisão e auditoria sem alterar a célula original. Uma possível inversão dia/mês é apenas uma sugestão, nunca aplicada automaticamente.

Clientes históricos só são agrupados quando nome normalizado e placa válida coincidem. Placas sem formato reconhecido não são corrigidas; a grafia original continua na ficha. O cadastro de uma moto usa o cliente do último registro da planilha, como referência a confirmar. Nomes sem placa e grafias diferentes ficam separados para evitar unir pessoas distintas.

## Atualizações das planilhas

Atualizações parciais usam um manifesto conferido com apenas as fichas novas no período solicitado. O relatório indica quantas fichas de cada aba já estavam cadastradas. O arquivo atualizado completo é preservado, e os registros fora do período continuam intactos.

Uma correção de placa na mesma ficha pode ser preparada em `sourceReviews`. Ela só é aplicada depois da importação, preserva as células anteriores, registra o arquivo atualizado e exige revisão vigente. A correção permite retirar um valor inválido ou manter a mesma placa normalizada; não altera o vínculo da moto nem valores ou serviços. Diferenças em outros campos exigem conferência própria.

`scripts/import-history-update.py DIRETORIO_PRIVADO ORIGINAIS` aplica o manifesto incremental, recusa uma carga nova se o banco mudou desde a cópia conferida e verifica os registros anteriores, fichas novas, arquivo original e totais por mês. Credenciais vêm apenas de `OFICINA_IMPORT_*`. Os arquivos privados de comparação e cópia não entram no Git. `tests/history-update.mjs` verifica esse fluxo em D1/R2 temporários, inclusive retomada, duplicidades e correção de placa.

## Persistência e integridade

D1 é a fonte dos registros. R2 guarda os arquivos originais. Nenhum dado da oficina é persistido em localStorage. Cada ordem guarda cliente, telefone, modelo e placa do atendimento como retrato histórico; mudanças no cadastro ou no proprietário não reescrevem ordens antigas. O vínculo da moto usa um ID estável mesmo se a placa mudar. Nomes iguais, por si só, não unificam clientes. Cadastros e ordem são inseridos em um único `batch` transacional. Os valores são calculados no servidor em centavos inteiros. Ordens têm uma chave idempotente e uma revisão para evitar sobrescritas concorrentes. Alterações são registradas em `audit_events`.

Para corrigir o nome ou telefone de um atendimento existente, abra a ficha e use **Corrigir cliente**. A operação também funciona em fichas importadas do Excel, preserva os vínculos, os valores financeiros, as células e os arquivos originais, e registra os dados anteriores na auditoria. Nas ordens manuais, os mesmos campos também podem ser alterados em **Editar atendimento**. A correção vale para o atendimento selecionado; o cadastro geral é editado em **Clientes**. A rota autenticada `PUT /api/orders/:id/review-customer` exige a revisão atual e rejeita alterações concorrentes. Teste de regressão: `node tests/customer-correction.mjs`.

A cópia JSON inclui todos os registros e a trilha de alterações. Ela não inclui senhas, sessões ou os bytes das planilhas (estes são baixados separadamente na interface). Ainda não há uma interface de restauração nem uma rotina de backup agendada.

## Acesso e operação

O endereço público permite abrir a tela de login fora do ChatGPT. A entrada no sistema continua exigindo a conta única da oficina. Clientes, motos, ordens, gastos, planilhas originais e cópias de segurança só são acessíveis após autenticação no servidor; não há cadastro público de usuários.

O modo original de configuração por ambiente continua disponível; as variáveis são gerenciadas como segredos no Sites, nunca no Git:

- `ADMIN_USERNAME`: usuário único.
- `ADMIN_PASSWORD_HASH`: hash scrypt (`N=32768,r=8,p=3`, salt aleatório de 24 bytes, resultado de 64 bytes).
- `APP_ORIGIN`: origem HTTPS exata da aplicação, usada para conferir solicitações de escrita.

Senha em texto puro nunca é armazenada. Cookies são `HttpOnly`, `Secure`, `SameSite=None; Partitioned`, com prefixo `__Host-`, para permitir sessão também quando a aplicação é aberta dentro do ChatGPT. O servidor guarda apenas SHA-256 dos tokens aleatórios de sessão. Trocar usuário ou hash e publicar invalida as sessões anteriores. As rotas de dados, downloads e uploads verificam a sessão. Escritas exigem origem esperada e cabeçalho próprio, inclusive no login. Há limite persistente de tentativas de login e limites de tamanho de entrada. Não há cadastro público nem recuperação de senha por email.

Ao trocar o domínio, atualizar `APP_ORIGIN` antes de publicar. Para trocar uma senha, gerar outro hash com `lib/password.ts`, atualizar o segredo e publicar; não colocar o valor em código, exemplos ou logs. A compatibilidade de `node:crypto` foi conferida na [documentação oficial do Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).

## Verificação e desenvolvimento

Preservar o fluxo do plugin Sites, o lockfile pnpm e `.openai/hosting.json`.

- `node node_modules/typescript/bin/tsc --noEmit`
- `node tests/integration.mjs`
- `node tests/finance.mjs` para conferir entradas, saídas, saldo negativo, valores ausentes, cancelamentos, filtros de datas e proteção dos dados sem login.
- `EXPENSE_MANIFEST_DIR=... HISTORY_ORIGINALS_DIR=... node tests/expenses.mjs` para cadastro e importação de todos os gastos em banco temporário, com validação de totais, origens e preservação dos atendimentos.
- `HISTORY_MANIFEST_DIR=... HISTORY_ORIGINALS_DIR=... node tests/history-import.mjs` para conferir todos os dados reais em D1/R2 locais temporários.
- Construir e publicar pelo fluxo oficial do Sites.

O teste de integração usa Workers/D1/R2 locais efêmeros e credenciais aleatórias. Exercita autenticação, CSRF, limite de tentativas, encerramento de sessão, cadastro conjunto, idempotência, valores, validações, mudança de proprietário, histórico, edição concorrente, filtros, paginação, exportação e preservação dos arquivos. O teste de histórico compara cada célula e item preservado, totais anuais, datas incertas, duplicidades, correções auditadas e a criação de uma nova ordem para uma moto importada. Nenhum dado de teste é enviado para produção.

O login foi conferido em Workers/D1 temporários. A verificação visual depende do navegador de controle do ambiente.

O WebMCP opcional expõe `search_workshop_history` apenas durante a sessão autenticada, usando a mesma API e estado visível. Não foi validado em um navegador compatível nesta entrega. Não houve teste visual ou de ponta a ponta no navegador; o perfil de execução limita esse tipo de teste a solicitações explícitas.

## Restauração de cópia completa em instalação vazia

A API autenticada `restore` prepara uma cópia `oficina-moto-v3` em tabelas separadas. O manifesto registra contagens e hashes por tabela; lotes repetidos são idempotentes e não sobrescrevem a preparação. Arquivos Excel originais são conferidos por SHA-256 antes de serem disponibilizados. Credenciais, sessões e segredos de ambiente não fazem parte da restauração.

A conclusão usa uma única transação D1, preservando IDs, vínculos, datas, valores e auditoria. Se houver registros no destino, inclusive criados durante a preparação, a operação recusa substituir dados. Uma falha de integridade reverte toda a transação. Importações concluídas retornam o mesmo resultado em novas tentativas.

Use `scripts/restore-backup.py DIRETORIO_PRIVADO --base-url ORIGEM_HTTPS --import` com `source-backup.json` e `originals/ID.bin`. A senha é lida sem eco; checkpoints e resultados permanecem no diretório privado, fora do Git. O script compara todos os campos e verifica novamente os arquivos após a importação. Preparações intermediárias internas das planilhas não fazem parte da exportação pública; o histórico concluído, seus relatórios e os arquivos originais são preservados.

`node tests/restore.mjs` verifica autenticação, CSRF, preparação imutável, hashes, repetição, rollback e preservação de registros concorrentes. `RESTORE_SOURCE_DIR=DIRETORIO_PRIVADO node tests/restore.mjs` também confere uma cópia real em D1/R2 temporários, sem enviar dados de teste para produção.
