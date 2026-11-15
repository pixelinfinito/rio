# Use o Rio em CI e análise de código

## Objetivo

Manter um relatório consumível por ferramentas, preservando o estado real de falha da revisão.

## Pré-requisitos

Checkout com histórico Git suficiente, dependências/ferramentas instaladas e política escolhida. Modo hospedado também exige credenciais. Não exponha segredos em jobs de forks não confiáveis. O Rio pode executar código do projeto.

## Passos

Busque a branch de comparação e histórico suficiente; use formato explícito:

```sh
rio doctor --base origin/main --format json
rio review --base origin/main --format json > rio-report.json
```

CI desativa a TUI; o formato explícito funciona fora de CI também. Se precisar enviar o artefato após falha, preserve o código:

```sh
status=0
rio review --base origin/main --format sarif > rio.sarif || status=$?
# Envie o arquivo se existir e for válido; preserve o resultado da revisão.
exit "$status"
```

No GitHub Actions, envie SARIF pela ação de code scanning com `security-events: write`, quando suportado. Execute o envio mesmo após falha da revisão, sem transformar a decisão final em `|| true`. Erro de argumentos ou segundo Ctrl-C pode deixar documento inválido/ausente; valide antes de enviar. JSON/Markdown também são artefatos úteis sem code scanning.

## Resultados esperados

SARIF usa versão 2.1.0; erros de invocação representam saídas 2/3 sem achados. A política define o bloqueio. Use `fail_on.required_checks: [typecheck, lint]` quando ferramentas ausentes precisarem falhar, pois verificações opcionais ignoradas podem retornar 0. Verificações do App GitHub são neutras e não substituem o bloqueio por política da CLI.

## Solução de problemas

Histórico raso: aprofunde/busque antes de comparar bases. Clones parciais: disponibilize os objetos necessários. Divergência de dependências hospedadas: provisione dependências compatíveis nas entradas; o Rio não as instala. Para revisão local offline, use `--offline` e isolamento externo quando subprocessos também precisarem ficar sem rede. Separe segredos de comandos controlados por PRs.

## Próximos passos

[Interprete códigos](results.md), [ajuste a política](profiles.md) ou [configure o GitHub App](github.md).
