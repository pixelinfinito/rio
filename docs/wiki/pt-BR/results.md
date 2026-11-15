# Entenda achados e relatórios

## Objetivo

Separar problemas demonstrados, hipóteses e trabalho incompleto, e exportar um relatório consumível por outras ferramentas.

## Pré-requisitos

Um resultado de revisão. Trate relatórios e caches como código-fonte: eles podem conter trechos e informações sensíveis do projeto.

## Passos

Leia nesta ordem: seleção/perfil; estado geral; resultado de cada verificação; achados e evidências; política/código de saída. A **severidade** descreve o impacto; o **nível de evidência**, o suporte à conclusão. `plausible` é hipótese, `static_proven` tem suporte estático e `reproduced` tem evidência de execução. `refuted` significa refutado. Categorias e estados distinguem defeitos/segurança/riscos e resultados novos/agravados/preexistentes/corrigidos/sem classificação.

```sh
rio review --format json > report.json
rio review --format md > report.md
rio review --format sarif > rio.sarif
```

Use `--show-pre-existing` para ver achados da base e `--show-remembered` para dispensas lembradas. Essas opções não substituem a alteração da política de falha.

## Resultados esperados

O JSON gera um documento `rio-report-v1` com estado `complete`, `incomplete`, `partial`, `no_changes` ou `error`; progresso vai para stderr. Erros de configuração/repositório após interpretar os argumentos também geram JSON. Erros de sintaxe e segundo Ctrl-C são exceções. Markdown não gera relatório nas saídas 2/3. SARIF 2.1.0 inclui erro de invocação e nenhum resultado nas saídas 2/3.

| Saída da revisão | Significado |
| --- | --- |
| 0 | Sem falha de política; verificações opcionais podem ter sido ignoradas |
| 1 | Achado corresponde à política geral ou de segurança |
| 2 | Erro de uso/configuração/perfil |
| 3 | Falha de repositório/interna/persistência |
| 4 | Trabalho incompleto/cancelado ou verificação obrigatória conforme a política |
| 5 | Publicação do PR falhou após revisão que passaria |
| 130 | Segundo Ctrl-C; sem documento final |

Um achado que falha tem prioridade sobre a saída 4. A política geral padrão seleciona defeitos novos/agravados com `static_proven` ou superior. Segurança tem política própria na etapa. O ID da revisão identifica as entradas; IDs únicos de execução identificam tentativas. Os registros ficam em `<cache>/<review-id>/runs/<run-id>/`.

## Solução de problemas

Nenhum achado com verificações falhas/ignoradas significa informação incompleta. Leia os motivos e execute [doctor](doctor.md). `fail_on.incomplete: false` muda a saída, não a completude da análise. Exija ferramentas essenciais com `fail_on.required_checks`.

## Próximos passos

[Ajuste a política](profiles.md), [use relatórios em CI](ci.md) ou [responda aos achados](feedback.md).
