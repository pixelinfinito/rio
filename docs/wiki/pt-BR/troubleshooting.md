# Solução de problemas e perguntas frequentes

Comece por `rio doctor --format json`; depois examine estado da revisão e motivos das verificações.

| Sintoma | O que fazer |
| --- | --- |
| Nenhuma alteração | Confira seleção: branch ignora edições locais; staged exige alterações no índice |
| Ferramenta ausente | Instale dependências/ferramentas fixadas; o Rio não as instala |
| Dependências divergentes | Sincronize com o lockfile; confiança não supera divergência conhecida |
| Sem IA / `no_endpoint` | Conecte endpoint e selecione perfil com modelos; revisão determinística continua útil |
| Perfil inválido | `rio profile validate`; confira caminhos YAML, herança e listas substituídas |
| Saída 0 com verificações ignoradas | Opcionais podem ser ignoradas; confira completude ou exija em fail_on |
| Saída 4 | Análise falha/cancelada ou verificação obrigatória ignorada; examine antes de mudar política |
| Saída 5 em PR | Publicação falhou; examine report.publication e comentários existentes |
| Sem TUI | Pipes, CI, --format explícito, --no-tui ou RIO_TUI=0 a desativam |
| Símbolos quebrados | Use --ascii / RIO_ASCII=1; aumente para pelo menos 80×24 |
| Histórico Git raso/parcial | Busque histórico/objetos suficientes antes de escolher a base |
| QA precondition_failed | Confira prontidão, dados, hosts bloqueados e serviços simulados |
| QA sync retorna 1 | Revise código/orientações alterados e atualize jornadas |
| Protocolo de endpoint inválido | Atualize versões pareadas de CLI/Worker/runner |
| Cache sem espaço/permissão | Examine caminho efetivo no doctor; ajuste configuração pessoal |

## Offline impede a rede de todos os processos?

Não. Impede requisições do Rio, não ferramentas/plugins/testes. Use isolamento externo para essa garantia.

## Maioria de IA comprova um defeito?

Não. Níveis de evidência e artefatos reais governam conclusões. Concordância do conselho não promove hipótese sem suporte.

## Por que meu perfil perdeu etapas?

Listas substituem as herdadas. Repita todas as etapas desejadas e valide dependências.

## Posso consultar documentação só com o executável?

Sim: `rio docs`, `rio docs search "termo"` e depois tópico/seção. Scripts de avaliação, diferentemente dos documentos, exigem o código.

Continue em [Guias](guides.md), [Referência](reference.md) ou [resultados](results.md).
