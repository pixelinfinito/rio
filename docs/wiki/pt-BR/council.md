# Use o conselho independente

## Objetivo

Solicitar avaliações independentes de achados ainda incertos após verificação, preservando o padrão de evidência.

## Pré-requisitos

Endpoint hospedado, adesão explícita de fornecedores, rotas/chaves e limites configurados. O conselho envia evidências a cada fornecedor participante permitido. A implementação existe, mas as tarefas finais/de aceitação A/B ao vivo continuam pendentes; isso não demonstra melhoria de qualidade.

## Passos

Inspecione `rio profile show rio/security` ou `rio profile show rio/critical`. O conselho é habilitado nesses perfis e desativado em `rio/base`. A configuração oferece seleção de fornecedores; `--no-council` pula a etapa. Uma entrada não interativa usa `--council-vendor FORNECEDOR:FAMILIA:ROTA`, repetida para os membros. Por exemplo, uma rota compatível configurada pode usar `google:gemini:compat/google-ai-studio/MODEL` com modelo real.

Tanto `council.vendors_allowed` no perfil quanto `COUNCIL_VENDORS` na implantação precisam permitir o fornecedor antes de preparar/enviar o pacote. Membros placeholder aparecem como não configurados, sem uso silencioso. Membros hospedados por você exigem runner com capacidade de modelo anunciada.

## Resultados esperados

Os gatilhos padrão incluem achados plausíveis graves, divergência entre verificadores, alto risco, execuções profundas e noturnas. Cinco papéis avaliam evidências idênticas independentemente, com até duas rodadas e dois experimentos; o mínimo padrão é três membros. Experimento que passa na base e falha na alteração pode reproduzir; proteção demonstrada pode refutar; casos restantes continuam plausíveis.

Contagem de concordâncias e pesos aprendidos não promovem evidência. Relatórios mostram decisão/nível, papéis, experimentos, nota, estados parciais/excluídos e custo. Auditoria identifica fornecedores/rotas e hashes sem registrar o conteúdo dos pacotes. Outros controles incluem max_findings, timeout e substituições de membros; veja a referência gerada.

## Solução de problemas

Membros não configurados/excluídos/expirados precisam permanecer visíveis. Conselho parcial não é decisão unânime. Confira as duas listas de permissão, diversidade de famílias e limite restante. Ausência de capacidade de modelo no runner impede participação própria. Consulte a avaliação A/B registrada antes de alegar qualidade.

## Próximos passos

[Defina limites](budgets.md) e [interprete evidências](results.md).
