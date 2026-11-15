# Prepare dados sintéticos e serviços simulados

## Objetivo

Iniciar cada sequência de navegador com dados reproduzíveis, simular serviços externos e inspecionar snapshots reutilizáveis.

## Pré-requisitos

`.rio/qa.yaml` revisado, definições de dados/fixtures, imagem Docker e aplicação pronta. Use contas sintéticas. Credenciais são fornecidas em execução, não versionadas nos arquivos iniciais. Construção/exportação de dados não chama modelos.

## Passos

Use `.rio/qa/seed/seed.yaml`, migrações SQL e `.rio/qa/fixtures/fixtures.yaml` da aplicação de exemplo como referência funcional. Defina snapshots de dados, comandos/arquivos iniciais, uploads nomeados, serviços simulados e verificações de mensagens capturadas. `rio qa init` pode propor definições ausentes, validadas antes da gravação.

```sh
rio qa fixtures status
rio qa seed status
rio qa seed build
rio qa seed export ./new-seed-inspection
```

Build restaura snapshot compatível ou executa os comandos dentro do contêiner isolado e captura um novo. `--force` reconstrói sem mudar a impressão digital nem apagar snapshots em uso. Export verifica hashes e grava arquivos opacos com `manifest.json`; não os extrai. O diretório pai deve existir, o destino deve ser novo e links simbólicos são recusados.

## Resultados esperados

A impressão digital inclui manifestos, migrações, definições/gravações/uploads, tipos de armazenamento, `seed.cache_version` e digest da imagem. Comandos de shell incluem conservadoramente o código capturado. Credenciais de personas são excluídas e aplicadas após restaurar. Altere cache_version quando outras entradas mudarem o conteúdo esperado.

`rio qa seed status --image APP_IMAGE` inspeciona imagem provisionada; digest indisponível é pré-requisito ausente. `rio qa seed prune --keep 3` apaga snapshots antigos elegíveis, preservando os mais novos e os em uso. Importação/publicação/limpeza compartilham travas.

## Solução de problemas

Use `app.test` nas URLs HTTP da aplicação e serviços simulados. Hosts bloqueados, TLS fixado e variáveis de SDK/URL não resolvidas aparecem nos diagnósticos. Falhas reais de dependência produzem `precondition_failed` nas jornadas afetadas/dependentes; as demais continuam. Corrija simulações ou contrato em vez de liberar rede arbitrária. `seed_too_large` identifica dados excessivos: reduza fixtures ou ajuste limites deliberadamente.

## Próximos passos

[Execute QA](qa.md), [mantenha sequências](qa-journeys.md) e [inspecione evidências](qa-evidence.md).

<!-- commands:start -->

<details>
<summary>Todas as opções dos comandos</summary>

## Referência de comandos

### `rio qa fixtures`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa fixtures status`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa seed`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa seed build`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--force` | Reconstrói e valida snapshots dos dados iniciais mesmo com cache correspondente. | `false` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa seed export`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `<directory>` | Novo diretório que recebe arquivos de dados verificados, sem extrair. | `—` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa seed prune`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--keep` | Preserva esta quantidade de snapshots recentes e os em uso. | `3` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio qa seed status`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--image` | Inspeciona esta imagem provisionada para estado dos dados. | `—` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |

</details>

<!-- commands:end -->
