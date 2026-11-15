# Ajuste profundidade, tempo e uso de modelos

## Objetivo

Escolher a profundidade e limitar recursos sem tratar uma execução incompleta como resultado limpo.

## Pré-requisitos

Presets exigem endpoint online configurado. Inspecione o perfil resolvido e os preços do provedor antes de aumentar limites.

## Passos

Use `rio review --preset standard` para revisão cotidiana equilibrada. Quick seleciona critical-only/fast; Standard, balanced/fast; Deep, thorough/deep. `--deep` é um atalho e conflita com `--preset`. Valores explícitos de evidência/quantidade do perfil mantêm prioridade.

Um perfil pode limitar tempo e tokens:

```yaml
version: 1
name: bounded
extends: rio/base
budget:
  fast:
    wall_time: 5m
    tokens: 100000
    verify_tokens: 20000
    agents_max: 3
```

Salve como perfil, execute `rio profile validate CAMINHO` e inspecione com `rio profile show CAMINHO`. O exemplo muda limites; não adiciona modelos. `verify_tokens` cobre os dois turnos de cada votante; `tokens` é o limite de toda a revisão. `budget.fast.qa`/`budget.deep.qa` controla tempo total/por célula/reexecução, tokens e bytes de evidências. A referência gerada lista os campos exatos.

## Resultados esperados

Relatórios expõem uso, leituras/gravações de cache, origem dos preços e trabalho incompleto. Custo ausente não significa custo zero. Limites são tetos, não estimativas. O schema não possui `cost_usd` no orçamento; controle tempo/tokens/agentes e acompanhe o custo medido.

`rio/openrouter` permite 12.000.000 de tokens e 40 minutos por revisão nos dois modos, dimensionados para uma alteração grande revisada em oito partes; a maioria das revisões usa bem menos, mas as maiores podem passar de meia hora. Seu verificador é um modelo diferente do revisor, então um voto examina cada risco (`verify.risk_voters: 1`); um perfil filho restaura o painel completo com `risk_voters: 3`, necessário quando um só modelo faz as duas coisas.

O perfil QA usa 500.000 tokens de revisão e 60.000 por votante em fast; deep usa 1.000.000 e 120.000. Capturas consomem tokens de visão. Padrões gerais e substituições explícitas podem diferir; consulte `profile show` na versão instalada.

## Solução de problemas

Se o limite acabar, confira etapas/células canceladas antes de aumentá-lo. Pausar a fila local de QA não pausa o relógio. Chamadas falhas com uso desconhecido podem manter reservas. Hipóteses reaproveitadas continuam sendo verificadas; desativar seu cache não desativa todos os caches. O conselho acrescenta membros/rodadas/experimentos com limites próprios.

## Próximos passos

[Escolha provedores](providers.md), [ajuste perfis](profiles.md) ou [entenda o conselho](council.md).
