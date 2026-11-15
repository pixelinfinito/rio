# Avalie o Rio com casos rotulados

## Objetivo

Medir ruído e preparar casos de incidentes sem confundir testes aprovados com qualidade de revisão demonstrada.

## Pré-requisitos

Python 3 e diretório `eval/` do código do Rio. Execute no checkout ou defina `RIO_EVAL_DIR` para a ferramenta. O executável sozinho não inclui esses scripts. Revisões/modelos ao vivo podem gerar custos e resultados; use casos/contas dedicados.

## Passos

```sh
rio eval noise --help
rio eval import-incident PR_URL FIX_PR_URL --help
```

Substitua URLs em importações reais e leia primeiro as opções encaminhadas. Noise revisa PRs considerados limpos e produz modelos de classificação/resumo. Importação de incidente relaciona a alteração ao PR que corrigiu seu defeito. Preserve classificação da base, identidade do caso, modelo, tempo e limites. Classifique independentemente, sem aceitar automaticamente cada afirmação do modelo.

## Resultados esperados

O Rio chama scripts Python isolados e propaga sua saída. Ferramenta ausente retorna 2 com instruções; falha ao iniciar Python retorna 3. Resultados usam os destinos selecionados pela ferramenta. A [referência de avaliação](../../../eval/README.md) explica conjuntos e interpretação.

## Solução de problemas

Executável fora do código precisa de `RIO_EVAL_DIR`; diretório homônimo sem `noise.py` e `incident.py` não é aceito. Bases ausentes invalidam algumas conclusões de qualidade. Os registros atuais não comprovam aceitação estável, e A/B ao vivo do conselho é um critério separado. Registre explicitamente verificações puladas/indisponíveis.

## Próximos passos

[Interprete evidências](results.md) e [mantenha a documentação](maintenance.md) quando o comportamento mudar.

<!-- commands:start -->

<details>
<summary>Todas as opções dos comandos</summary>

## Referência de comandos

### `rio eval`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio eval noise`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `<args>` | Encaminha argumentos restantes à ferramenta de avaliação. | `—` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
### `rio eval import-incident`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `<pr>` | URL do pull request do incidente a importar para o conjunto de avaliação. | `—` |
| `<fix_pr>` | URL do pull request que corrigiu o incidente. | `—` |
| `<args>` | Encaminha argumentos restantes à ferramenta de avaliação. | `—` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |

</details>

<!-- commands:end -->
