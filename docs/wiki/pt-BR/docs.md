# Dê documentação ao agente pela CLI

## Objetivo

Recuperar apenas a informação necessária à próxima tarefa, correspondente à versão, sem site nem manual extenso no contexto.

## Pré-requisitos

Somente o executável Rio. Os comandos funcionam offline, fora de repositórios, sem configuração, credenciais, ferramentas auxiliares ou cache. Não executam revisão nem alteram dados.

## Passos

```sh
rio docs
rio docs search "dependency mismatch"
rio docs review
rio docs profiles --section inheritance
rio docs review --format json
```

Comece pelo índice curto. A busca retorna referências de tópicos/seções com motivos breves, não documentos completos. Consulte o tópico relevante ou uma seção com pré-requisitos e efeitos. `rio docs list` equivale ao índice. A busca aceita `--limit 1..10` (padrão 5); coloque várias palavras entre aspas. Consultas vazias/acima de 256 bytes são erros; nenhum resultado é sucesso com lista vazia.

## Resultados esperados

Conteúdo compacto em inglês é embutido no executável. O JSON usa `schema_version: 1`, `rio_version`, `rio_commit`, `docs_revision`, `kind` e `data`. Texto/JSON não incluem ANSI, progresso, paginador ou TUI. Mesmo executável/argumentos produzem a mesma saída, independentemente de idioma/diretório.

Limites totais de texto: índice/busca/seção 4 KiB e 800 tokens de referência; tópico 8 KiB e 1.800 tokens. JSON: no máximo 12 KiB/3.000 tokens de referência. Medições usam `o200k_base` fixado; outros tokenizadores diferem. Tópicos excessivos falham na validação em vez de serem cortados. Não há opção de despejo do acervo inteiro.

## Solução de problemas

Saída 0 significa sucesso; 2, uso ou tópico/seção desconhecido; 3, falha interna/saída. Erros textuais usam stderr. Erros semânticos após interpretar argumentos retornam um envelope JSON quando solicitado; erros de sintaxe continuam em stderr, sem garantia de JSON. Seções desconhecidas listam IDs válidos em vez de despejar o tópico. IDs nunca apontam para arquivos ou URLs.

Um executável antigo mantém seus próprios documentos após mudanças na Wiki. Confira metadados de versão em vez de pressupor que todas as opções do manual novo existem.

## Próximos passos

Para orientar agentes, use: “Execute `rio docs`, consulte somente tópicos/seções relevantes e use `--format json` para documentação estruturada.” Continue com [revisão](review.md) ou [perfis](profiles.md).

<!-- commands:start -->

## Referência de comandos

### `rio docs`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `<topic>` | ID de tópico embutido, list ou search. | `—` |
| `<query>` | Termos de busca entre aspas; não vazios, até 256 bytes UTF-8. | `—` |
| `--section` | Consulta uma seção embutida com seus pré-requisitos. | `—` |
| `--limit` | Máximo de resultados na busca documental, 1–10; padrão 5. | `—` |
| `--format` | Escolhe formato de saída; valores suportados são listados. | `text, json` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |

<!-- commands:end -->
