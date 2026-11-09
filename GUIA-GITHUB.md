# GitHub → Cloudflare

Repositório de trabalho: https://github.com/soaresjohn222-netizen/fabin
Branch de produção: `main`.

## Estado atual

O repositório está conectado ao Cloudflare Workers Builds. Pushes em `main`
executam os testes, compilam e publicam automaticamente o Worker `oficinafabin`.
O GitHub Actions também verifica os commits e pull requests.

Endereço de produção: https://oficinafabin.soaresjohn222.workers.dev

## Conexão inicial no painel Cloudflare

1. Workers & Pages → Create application → GitHub.
2. Autorizar somente o repositório `soaresjohn222-netizen/fabin` e selecionar `main`.
3. Nome do Worker: `oficinafabin` (igual ao arquivo Wrangler).
4. Diretório raiz: `/`.
5. Build: `pnpm check && pnpm build:cloudflare`.
6. Deploy: `pnpm deploy:cloudflare`.
7. Configurar os recursos reais e segredos antes de publicar.

A configuração em `wrangler.cloudflare.jsonc` contém o ID real do D1.
O destino usa Cloudflare Workers Free e D1, Supabase Auth para login e
Supabase Storage privado para os arquivos. Não depende de R2 ou Workers Paid.
Os segredos de execução ficam no painel Cloudflare, fora do Git e do frontend.
Os previews de outras branches estão desabilitados.

## Rotina de atualização

1. Fazer a alteração e executar `pnpm check` e `pnpm build:cloudflare`.
2. Commit e push para `main` (ou pull request antes de integrar).
3. GitHub verifica o commit; a integração Cloudflare compila e publica os pushes
   em `main`.
4. Conferir a publicação e o endereço público. Se um teste do build falhar,
   o comando de publicação não deve executar.

Clientes, históricos e arquivos não ficam no Git. A migração dos dados é uma
etapa separada e precisa usar uma cópia atual. Segredos são configurados na
hospedagem. Não colocar senhas, chaves, exports ou planilhas no repositório.

Mudar a estrutura do banco exige migrations compatíveis: deploy de código não
migra registros automaticamente. As migrations SQL ficam em `drizzle/`.
