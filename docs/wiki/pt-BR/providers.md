# Escolha provedores e rotas de modelos

## Objetivo

Usar um provedor suportado, uma API compatível própria ou uma rota configurada no gateway.

## Pré-requisitos

Endpoint online e credenciais do provedor. Trechos de código e evidências podem ser enviados aos provedores escolhidos. Autenticação do gateway e chaves do provedor são distintas.

## Passos

Comece por `rio profile show rio/openrouter` ou `rio profile show rio/anthropic` para inspecionar os aliases. Após fornecer a chave correspondente na configuração, use `rio review --profile rio/openrouter --preset standard`. Confira o perfil resolvido: `rio/base` não define rotas de modelos.

Para um endpoint personalizado, registre-o no init:

```sh
rio init --custom-provider my-api:openai:https://api.example.invalid/v1 --default-model custom-my-api/MODEL
```

Substitua URL/modelo pelo serviço real. O protocolo é `openai` ou `anthropic`. A chave é fornecida privadamente em `AI_GATEWAY_PROVIDER_KEY_MY_API`: transforme o slug em maiúsculas e troque hífens por sublinhados. O perfil usa `custom-my-api/MODEL`. `--verifier-model` escolhe outra rota para verificação; um verificador de um único votante precisa resolver para modelo diferente do padrão.

Também são suportadas rotas `compat/…` do AI Gateway e `dynamic/ROUTE` configuradas. Metadados, preços opcionais e definições personalizadas ficam em `[deployment]`; chaves permanecem no armazenamento de segredos. Veja a referência gerada e os [exemplos de gateway existentes](../../cloudflare.md#custom-endpoints-through-ai-gateway) para campos específicos de protocolo.

## Resultados esperados

O perfil resolvido identifica aliases/rotas e os relatórios mostram a origem das informações de uso. Rotas ou autenticação ausentes geram trabalho falho/adiado explícito; não contam como verificação concluída.

## Solução de problemas

Confira normalização do slug, protocolo, URL base e nome do modelo. O endpoint precisa implementar o protocolo escolhido; uma URL compatível com OpenAI não é automaticamente compatível com Anthropic. Evite credenciais na URL. Atualize chaves privadas e execute `rio deploy` para instalar novos segredos do Worker.

Cache de prompts é diferente de cache de respostas do gateway. A implantação mantém cache de respostas e logs de prompts do gateway desativados. `[deployment.prompt]` controla sugestões de cache e ajustes de organização; relatórios distinguem leituras/gravações de cache e preços indisponíveis. [Limites e contabilização](budgets.md) explica a interpretação.

## Próximos passos

[Limite o trabalho dos modelos](budgets.md) e [revise uma pequena alteração](review.md).
