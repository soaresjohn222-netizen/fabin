# Publicação independente na Cloudflare

A versão atual e a correção de nomes estão preservadas. A publicação no Sites
continua usando a configuração existente; os comandos abaixo usam uma configuração
separada para a conta Cloudflare do proprietário.

1. Autenticar a conta com Wrangler ou pelo painel Cloudflare.
2. Criar D1 `oficinafabin-db` e R2 `oficinafabin-arquivos` nessa conta.
3. Preencher `database_id` em `wrangler.cloudflare.jsonc` com o ID retornado por D1.
   Os nomes de banco/bucket podem ser ajustados antes da compilação.
4. Aplicar o esquema no banco vazio:
   `pnpm exec wrangler d1 migrations apply DB --remote --config wrangler.cloudflare.jsonc`.
5. Compilar com `pnpm build:cloudflare` e publicar com `pnpm deploy:cloudflare`.
   O comando de publicação rejeita o ID de banco provisório e builds de outra configuração.
6. Configurar no Worker `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` e `APP_ORIGIN`.
   O hash deve ser segredo; a senha original nunca deve entrar no Git ou em argumentos.
   `APP_ORIGIN` deve ser a origem HTTPS pública exata, sem barra final.
7. Transferir uma cópia ATUAL dos dados e todos os arquivos originais para o destino
   vazio, usando `scripts/restore-backup.py`. Ele preserva IDs e confere campos e arquivos.
   Não usar um backup antigo para substituir registros mais recentes.
8. Verificar o login, a correção de clientes, os totais e os downloads antes de entregar
   o novo endereço. O sistema atual permanece disponível durante a migração.

A autenticação usa scrypt, que exige CPU para validar senhas. Confirmar os limites
do plano Workers da conta antes de liberar o login; não reduzir a segurança do hash
para contornar limites de execução.

Este arquivo descreve a preparação. Banco, bucket, secrets e publicação precisam
ser realizados na conta autenticada; a compilação local não cria um link público.
