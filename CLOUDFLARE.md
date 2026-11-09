# Publicação independente: Cloudflare Free e Supabase Free

A versão atual e a correção de nomes estão preservadas. A publicação no Sites
continua usando a configuração existente; os comandos abaixo usam uma configuração
separada para a conta Cloudflare do proprietário.

1. Autenticar a conta com Wrangler ou pelo painel Cloudflare.
2. Usar D1 `oficinafabin-db` e o projeto Supabase `ayqtyecrthoyymmyklvy`.
   Criar no Supabase Storage o bucket PRIVADO `oficinafabin-arquivos`, com limite
   de arquivo de 20 MiB. O destino independente não usa R2.
3. Preencher `database_id` em `wrangler.cloudflare.jsonc` com o ID retornado por D1.
   Os nomes de banco/bucket podem ser ajustados antes da compilação.
4. Aplicar o esquema no banco vazio:
   `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.cloudflare.jsonc`.
5. Compilar com `pnpm build:cloudflare` e publicar com `pnpm deploy:cloudflare`.
   O comando de publicação rejeita o ID de banco provisório e builds de outra configuração.
6. Criar a identidade administrativa no Supabase Auth com a senha existente,
   sem convite por e-mail. Configurar no Worker `SUPABASE_ADMIN_EMAIL`,
   `SUPABASE_ADMIN_ID` (UUID exato) e `SUPABASE_PUBLISHABLE_KEY`.
   Salvar `SUPABASE_SECRET_KEY` exclusivamente como secret de execução no Worker.
   A chave e a senha original nunca devem entrar no Git, logs ou argumentos.
   `ADMIN_USERNAME=oficina`, os provedores Supabase, URL e bucket estão na configuração.
   `APP_ORIGIN` deve ser a origem HTTPS pública exata, sem barra final.
7. Transferir uma cópia ATUAL dos dados e todos os arquivos originais para o destino
   vazio, usando `scripts/restore-backup.py`. Ele preserva IDs e confere campos e arquivos.
   Não usar um backup antigo para substituir registros mais recentes.
8. Verificar o login, a correção de clientes, os totais e os downloads antes de entregar
   o novo endereço. O sistema atual permanece disponível durante a migração.

No destino, a senha é verificada pelo Supabase Auth, preservando a tela com usuário
`oficina`. Só o UUID administrativo configurado recebe acesso. Os tokens do provedor
nunca são enviados ao navegador: o aplicativo mantém suas sessões revogáveis em D1,
cookies HttpOnly, proteção CSRF e limite de tentativas. Uma configuração incompleta
bloqueia o acesso, sem fallback para login local no destino Cloudflare.

Mudar `AUTH_VERSION` para revogar todas as sessões, inclusive após trocar a senha.
A configuração antiga do Sites preserva scrypt e o armazenamento já existentes.

Para atualizações automáticas, conectar `soaresjohn222-netizen/fabin`, branch `main`,
ao Workers Builds. Build: `pnpm check && pnpm build:cloudflare`.
Deploy: `pnpm deploy:cloudflare`. Não habilitar previews com dados de produção.

O banco D1, o bucket privado e os segredos estão configurados na conta do
proprietário. A publicação usa Workers Builds a partir da branch main.
A compilação local isolada não publica nem migra dados.
