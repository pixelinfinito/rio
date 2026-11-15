# Entenda dados, cache e modo offline

## Objetivo

Saber para onde vão código/evidências e escolher retenção adequada ao projeto.

## Pré-requisitos

Acesso à configuração pessoal e conhecimento do modo local/hospedado. Proteja o cache como protege o código-fonte.

## Passos

Use `rio doctor --format json` para inspecionar caminho efetivo, espaço livre e ajustes. Padrões: `.rio/cache`, 30 dias, 5 GiB e saída bruta retida. Altere `cache.dir`, `max_age`, `max_size`, `retain_raw_output` no `config.toml` pessoal ou variáveis `RIO_CACHE_*` correspondentes.

Caches locais contêm snapshots imutáveis, árvores extraídas, perfis, achados, trechos do grafo e saídas redigidas. Cada ferramenta executa numa cópia descartável, sem alterar a fonte em cache. Dependências podem ser vinculadas à instalação da worktree. Execuções concorrentes usam travas e diretórios distintos.

Revisões hospedadas enviam snapshots base/alteração ao endpoint. Rotas de modelos e fornecedores permitidos do conselho recebem contexto/evidências limitados. Auditoria de dependências envia nomes, versões e ecossistemas ao OSV. Snapshots de código podem conter segredos mesmo com saída bruta redigida.

## Resultados esperados

No Unix, diretórios/arquivos usam 0700/0600; no Windows herdam ACLs. Fluxos brutos preservam início/fim, limitados a 16 MiB cada. `retain_raw_output = false` evita novos fluxos, mas não apaga snapshots ou registros existentes. Regras de idade/tamanho/uso limpam entradas elegíveis, protegendo referências ativas.

`--offline` desativa requisições do Rio. Não isola linters/plugins/testes da rede. Para bloquear todo tráfego, use isolamento externo ou desative verificações com subprocessos deliberadamente. Opções exclusivas do endpoint falham em offline, sem mudar silenciosamente de significado.

## Solução de problemas

Disco cheio: confira caminho e execuções ativas; ajuste retenção ou remova caches desnecessários deliberadamente. Desinstalar não busca caches nos repositórios. Cópias locais ausentes de linhagem são recuperadas do endpoint, não reiniciadas. Cache de hipóteses evita geração repetida para contexto igual, mas mantém verificação; `cache: false` em rio/agents desativa somente esse cache.

## Próximos passos

[Altere ajustes pessoais](configuration.md), [gerencie evidências QA](qa-evidence.md) ou [revise localmente](review.md).
