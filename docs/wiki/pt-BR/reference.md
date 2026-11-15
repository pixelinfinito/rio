# Referência de comandos e configurações

Consulte um comando, arquivo, ajuste ou código de saída específico. Para um passo a passo, use [Guias](guides.md). Abra **Todas as opções dos comandos** no guia indicado para ver a tabela completa de argumentos gerada pelo parser.

## Consultas frequentes

| Encontre | Referência |
| --- | --- |
| Seleção da revisão: árvore de trabalho, arquivos preparados, branch ou PR | [Comandos de revisão](review.md#referência-de-comandos) |
| Atalhos de teclado e telas interativas | [Interface do terminal](tui.md) |
| Achados, evidências, resultados incompletos, códigos de saída e exportação | [Resultados](results.md) |
| Herança de perfis, padrões e substituição de listas | [Perfis](profiles.md) |
| Ajustes da máquina, variáveis de ambiente e precedência | [Configuração](configuration.md) |
| Rotas de modelos, verificação e limites de recursos | [Provedores](providers.md) · [Limites](budgets.md) |
| Etapas, módulos, adaptadores e todos os campos dos schemas | [Referência de módulos e schemas](modules.md) |
| Documentação local para agentes e envelopes JSON | [Documentação embutida](docs.md) |

## Arquivos de configuração

| Arquivo ou local | Finalidade | Detalhes |
| --- | --- | --- |
| `.rio/profiles/default.yaml` | Política do repositório e etapas padrão | [Perfis](profiles.md) |
| `.rio/profiles/NAME.yaml` | Perfil nomeado do repositório | [Perfis](profiles.md) |
| Diretório pessoal: `config.toml`, `profiles/` | Endpoint, cache, limites da máquina e perfis pessoais | [Caminhos e precedência](configuration.md) |
| `.rio/qa.yaml` | Inicialização da aplicação, personas e navegador | [Configuração QA](qa.md) |
| YAML de jornadas e `REVIEW.md` | Jornadas de usuários e orientações do projeto | [Jornadas](qa-journeys.md) |
| Contratos de dados iniciais e fixtures | Dados sintéticos e fixtures de serviços/arquivos | [Dados e fixtures](qa-seeds.md) |
| `.rio/cache` | Cache padrão do repositório; não é configuração pessoal | [Cache e privacidade](cache.md) |

## Variáveis de ambiente

| Grupo | Chaves | Detalhes |
| --- | --- | --- |
| Configuração da máquina | `RIO_CONFIG_DIR`, `XDG_CONFIG_HOME`, `RIO_ENDPOINT_URL`, `RIO_PARALLELISM`, `RIO_OUTPUT_LIMIT` | [Configuração](configuration.md) |
| Cache | `RIO_CACHE_DIR`, `RIO_CACHE_MAX_AGE`, `RIO_CACHE_MAX_SIZE`, `RIO_CACHE_RETAIN_RAW_OUTPUT` | [Configuração](configuration.md) · [Cache](cache.md) |
| Terminal | `RIO_TUI`, `RIO_ASCII`, `NO_COLOR` | [Interface do terminal](tui.md) |
| Instalação | `RIO_VERSION`, `RIO_INSTALL_DIR`, `RIO_DOWNLOAD_BASE` | [Instalação](installation.md) |
| Credenciais | `RIO_API_TOKEN`, chaves de provedores e segredos do runner | [Conexão e implantação](hosting.md) · [Provedores](providers.md). Forneça segredos de forma privada. |

## Códigos de saída

Os códigos dependem do comando. Uma saída diferente de zero na revisão pode indicar achados ou verificações incompletas; `doctor` usa outros códigos, e a publicação pode falhar após uma revisão aprovada. Veja a [tabela por comando](results.md). Para `rio docs`, consulte o [contrato de consulta e erros](docs.md).

<!-- command-index:start -->

## Consulta de comandos

| Comando | Guia / opções |
| --- | --- |
| `rio` | [Referência de comandos e configurações](reference.md#rio) |
| `rio docs` | [Dê documentação ao agente pela CLI](docs.md#rio-docs) |
| `rio review` | [Sua primeira revisão local](review.md#rio-review) |
| `rio qa` | [Sua primeira execução de QA no navegador](qa.md#rio-qa) |
| `rio qa init` | [Sua primeira execução de QA no navegador](qa.md#rio-qa-init) |
| `rio qa validate` | [Sua primeira execução de QA no navegador](qa.md#rio-qa-validate) |
| `rio qa list` | [Sua primeira execução de QA no navegador](qa.md#rio-qa-list) |
| `rio qa show` | [Sua primeira execução de QA no navegador](qa.md#rio-qa-show) |
| `rio qa fixtures` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-fixtures) |
| `rio qa fixtures status` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-fixtures-status) |
| `rio qa rules` | [Sua primeira execução de QA no navegador](qa.md#rio-qa-rules) |
| `rio qa seed` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-seed) |
| `rio qa seed build` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-seed-build) |
| `rio qa seed export` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-seed-export) |
| `rio qa seed prune` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-seed-prune) |
| `rio qa seed status` | [Prepare dados sintéticos e serviços simulados](qa-seeds.md#rio-qa-seed-status) |
| `rio qa evidence` | [Examine evidências de QA e recomendações de UX](qa-evidence.md#rio-qa-evidence) |
| `rio qa evidence prune` | [Examine evidências de QA e recomendações de UX](qa-evidence.md#rio-qa-evidence-prune) |
| `rio qa sync` | [Mantenha jornadas e orientações dos responsáveis](qa-journeys.md#rio-qa-sync) |
| `rio profile` | [Ajuste verificações com perfis](profiles.md#rio-profile) |
| `rio profile list` | [Ajuste verificações com perfis](profiles.md#rio-profile-list) |
| `rio profile show` | [Ajuste verificações com perfis](profiles.md#rio-profile-show) |
| `rio profile validate` | [Ajuste verificações com perfis](profiles.md#rio-profile-validate) |
| `rio doctor` | [Diagnostique ferramentas e preparação](doctor.md#rio-doctor) |
| `rio init` | [Adicione revisão por IA: conecte ou implante](hosting.md#rio-init) |
| `rio deploy` | [Adicione revisão por IA: conecte ou implante](hosting.md#rio-deploy) |
| `rio feedback` | [Responda aos achados e acompanhe o histórico](feedback.md#rio-feedback) |
| `rio findings` | [Responda aos achados e acompanhe o histórico](feedback.md#rio-findings) |
| `rio suppressions` | [Aplique ou recuse propostas de supressão](suppressions.md#rio-suppressions) |
| `rio suppressions list` | [Aplique ou recuse propostas de supressão](suppressions.md#rio-suppressions-list) |
| `rio suppressions apply` | [Aplique ou recuse propostas de supressão](suppressions.md#rio-suppressions-apply) |
| `rio suppressions decline` | [Aplique ou recuse propostas de supressão](suppressions.md#rio-suppressions-decline) |
| `rio eval` | [Avalie o Rio com casos rotulados](evaluation.md#rio-eval) |
| `rio eval noise` | [Avalie o Rio com casos rotulados](evaluation.md#rio-eval-noise) |
| `rio eval import-incident` | [Avalie o Rio com casos rotulados](evaluation.md#rio-eval-import-incident) |

<!-- command-index:end -->

<!-- schema-topics:start -->

## Tabelas completas dos schemas

- [Campos de perfil](modules.md#campos-de-perfil)
- [Campos do ambiente QA](modules.md#campos-do-ambiente-qa)
- [Campos de jornada](modules.md#campos-de-jornada)
- [Campos de dados iniciais](modules.md#campos-de-dados-iniciais)
- [Campos de fixtures](modules.md#campos-de-fixtures)

<details>
<summary>Páginas compactas de consulta anteriores</summary>

Os endereços existentes continuam disponíveis. Prefira as tabelas completas acima para leitura; agentes podem consultar seções pequenas com `rio docs`.

- [profile-fields-1](profile-fields-1.md)
- [profile-fields-2](profile-fields-2.md)
- [qa-config-fields-1](qa-config-fields-1.md)
- [qa-journey-fields-1](qa-journey-fields-1.md)
- [qa-seed-fields-1](qa-seed-fields-1.md)
- [qa-fixtures-fields-1](qa-fixtures-fields-1.md)
- [qa-config-fields-2](qa-config-fields-2.md)

</details>

<!-- schema-topics:end -->

O comando interno `rio prepare` é exclusivo do runner. Ele não faz parte dos fluxos normais de uso.

<!-- commands:start -->

<details>
<summary>Todas as opções dos comandos</summary>

## Referência de comandos

### `rio`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--help` | Mostra sintaxe e opções do comando. | `—` |
| `--version` | Mostra versão, plataforma de destino e commit. | `—` |

</details>

<!-- commands:end -->
