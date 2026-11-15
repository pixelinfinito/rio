# Configure sua máquina

## Objetivo

Escolher limites de recursos, caminhos de cache e endpoint sem permitir que um repositório clonado controle a configuração da máquina.

## Pré-requisitos

Localize o diretório pessoal: `RIO_CONFIG_DIR`, depois `$XDG_CONFIG_HOME/rio` e, por fim, `~/.config/rio` no Linux/macOS. No Windows, usa-se `%APPDATA%\rio`, com `%USERPROFILE%\.config\rio` como alternativa. O arquivo é `config.toml`. Nunca coloque segredos em um perfil do repositório.

## Passos

Crie ou edite o arquivo pessoal, preservando as seções de implantação/App existentes:

```toml
[cache]
max_age = "7d"
max_size = "2GiB"
retain_raw_output = false
[run]
parallelism = 2
output_limit = "128MiB"
```

Execute `rio doctor --format json` para ver valores efetivos e origens. Opções correspondentes do comando prevalecem sobre ambiente, que prevalece sobre arquivo e padrões. Valores inválidos no arquivo são rejeitados mesmo quando uma variável de ambiente os substituiria.

| Chave no arquivo | Ambiente | Padrão |
| --- | --- | --- |
| `endpoint.url` | `RIO_ENDPOINT_URL` | Não definido |
| `cache.dir` | `RIO_CACHE_DIR` | `.rio/cache` do repositório |
| `cache.max_age` | `RIO_CACHE_MAX_AGE` | `30d` |
| `cache.max_size` | `RIO_CACHE_MAX_SIZE` | `5GiB` |
| `cache.retain_raw_output` | `RIO_CACHE_RETAIN_RAW_OUTPUT` | `true` |
| `run.parallelism` | `RIO_PARALLELISM` | Núcleos físicos, no máximo 4 |
| `run.output_limit` | `RIO_OUTPUT_LIMIT` | `256MiB` por fluxo de saída da ferramenta |

`RIO_TUI=0`, `RIO_ASCII=1` e `NO_COLOR` controlam a apresentação. `RIO_API_TOKEN` fornece autenticação do endpoint. Chaves de provedores e tokens de implantação usam as entradas privadas documentadas; [hospedagem](hosting.md) explica a configuração. `[deployment]` guarda escolhas reutilizáveis e `[github_app]`, identificadores do App. Isso é separado da política de revisão do repositório.

## Resultados esperados

O diagnóstico identifica a origem de cada valor efetivo. Limites de retenção afetam a limpeza; desativar saída bruta não apaga automaticamente snapshots de código ou artefatos antigos.

## Solução de problemas

Uma chave TOML desconhecida gera erro de configuração com o nome da chave. Use paralelismo positivo e unidades suportadas de bytes/duração. Um `.rio/config.toml` no repositório não substitui ajustes da máquina. Se o chaveiro estiver indisponível em um servidor sem interface, escolha explicitamente o armazenamento em arquivo durante a implantação, em vez de colocar chaves no TOML.

## Próximos passos

[Ajuste a política](profiles.md), [entenda a privacidade do cache](cache.md) ou [conecte um endpoint](hosting.md).
