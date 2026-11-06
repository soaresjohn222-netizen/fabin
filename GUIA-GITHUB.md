# GitHub → Cloudflare

Repositório de trabalho: https://github.com/soaresjohn222-netizen/fabin
Branch de produção: `main`.

## Estado atual

O código foi sincronizado com a versão atual do sistema, incluindo a correção
nos nomes dos clientes. O GitHub Actions verifica os commits e pull requests.
O fluxo de publicação Cloudflare precisa ser conectado uma única vez no painel.
Não existe ainda nova publicação gratuita pronta para uso nesta conta.

## Conexão inicial no painel Cloudflare

1. Workers & Pages → Create application → GitHub.
2. Autorizar somente o repositório `soaresjohn222-netizen/fabin` e selecionar `main`.
3. Nome do Worker: `oficinafabin` (igual ao arquivo Wrangler).
4. Diretório raiz: `/`.
5. Build: `pnpm check && pnpm build:cloudflare`.
6. Deploy: `pnpm deploy:cloudflare`.
7. Configurar os recursos reais e segredos antes de publicar.

A configuração Cloudflare em `wrangler.cloudflare.jsonc` ainda usa um ID D1
provisório. A publicação recusa esse ID. O deploy só pode ser ativado depois da
adaptação ao plano gratuito e da configuração real dos recursos.
A arquitetura atual usa R2 e scrypt: os requisitos gratuitos ainda não foram
validados. Não ativar R2 ou Workers Paid sem autorização; não reduzir a segurança
para contornar limites. O plano discutido é usar Cloudflare Free e serviços
Supabase Free para autenticação e arquivos, mas isso ainda exige implementação.

## Rotina de atualização

1. Fazer a alteração e executar `pnpm check` e `pnpm build:cloudflare`.
2. Commit e push para `main` (ou pull request antes de integrar).
3. GitHub verifica o commit; a integração Cloudflare compila e publica os pushes
   em `main` quando estiver conectada.
4. Conferir a publicação e o endereço público. Se um teste do build falhar,
   o comando de publicação não deve executar.

Clientes, históricos e arquivos não ficam no Git. A migração dos dados é uma
etapa separada e precisa usar uma cópia atual. Segredos são configurados na
hospedagem. Não colocar senhas, chaves, exports ou planilhas no repositório.

Mudar a estrutura do banco exige migrations compatíveis: deploy de código não
migra registros automaticamente. As migrations SQL ficam em `drizzle/`.
