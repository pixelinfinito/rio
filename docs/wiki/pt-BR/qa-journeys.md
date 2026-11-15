# Mantenha jornadas e orientações dos responsáveis

## Objetivo

Conectar testes do navegador aos objetivos reais e detectar quando mudanças no código deixam jornadas desatualizadas.

## Pré-requisitos

Ambiente QA válido e dados/fixtures sintéticos. A autoria inicia aplicação/navegador isolados e usa autenticação de modelo. Jornadas são versionadas em `.rio/qa/journeys/`.

## Passos

Escreva `REVIEW.md` nos diretórios relevantes. Descreva usuário, objetivo, recuperação esperada de erros, acessibilidade e escolhas intencionais. Orientações informam avaliações, mas não concedem ferramentas nem substituem limites/políticas.

Uma jornada descreve persona, cobertura, pré-condições, passos e sucesso. Por exemplo:

```yaml
version: 1
name: visit-home
title: Visit the home page
persona: guest
tags: [smoke]
covers:
  paths: ['src/**']
  routes: ['/']
preconditions: []
steps:
  - do: Open the home page
    at: /
    expect: The main navigation is visible
success:
  - The visitor can identify the next action
```

Adapte expectativas à aplicação e execute `rio qa validate` e `rio qa show visit-home`. `rio qa init` explora a aplicação com dados iniciais para criar jornadas; as existentes recebem candidatas `.proposed.yaml`. Revise propostas antes de versionar substituições.

## Resultados esperados

`rio qa sync --check` retorna 1 quando código coberto ou orientações aplicáveis mudam sem atualização da jornada. É somente leitura. `rio qa sync` percorre novamente jornadas desatualizadas e escreve propostas validadas, preservando arquivos confirmados/edições concorrentes. Autoria incompleta não grava propostas.

Use `after` para sequências com estado compartilhado, como login → carrinho → pagamento. O início da sequência pode usar `resets: true`; combinar com `after` é inválido. Viewports de dependentes devem ser subconjunto dos pré-requisitos. Cada sequência começa com dados restaurados e novo contexto de navegador por célula. Os membros precisam resolver para o mesmo `context.time` ou todos usar tempo real; tempo omitido herda padrões das fixtures.

## Solução de problemas

Ciclo de dependências ou divergência de viewports é erro de contrato, não falha do navegador. Revise jornadas confirmadas e propostas. `--force` permite substituição validada no init, mas protege alterações concorrentes. `sync --staged`/`--base REF` selecionam a comparação desejada.

## Próximos passos

[Gerencie fixtures](qa-seeds.md) e [leia evidências das células](qa-evidence.md).

<!-- commands:start -->

## Referência de comandos

### `rio qa sync`

| Argumento | Significado | Padrão / valores |
| --- | --- | --- |
| `--check` | Informa cobertura desatualizada sem gravar propostas. | `false` |
| `--staged` | Seleciona somente o índice contra HEAD; conflita com --base. | `false` |
| `--base` | Compara HEAD confirmado com a base comum desta referência. | `—` |
| `--help` | Mostra sintaxe e opções do comando. | `—` |

<!-- commands:end -->
