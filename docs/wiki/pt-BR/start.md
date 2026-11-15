# Comece com o Rio

O Rio revisa alterações do Git e explica possíveis problemas com evidências. Ele executa verificações de tipos, linters, testes para cobertura do código alterado, detecção de segredos e análise de dependências na sua máquina. Com um endpoint próprio, acrescenta revisão por IA, verificação independente, integração com PRs. QA no navegador usa seus próprios pré-requisitos de Docker e modelo.

## Escolha sua primeira tarefa

- [Revisar minhas alterações locais](review.md): o caminho mais curto; não exige conta na nuvem.
- [Adicionar revisão por IA](hosting.md): conecte um endpoint existente ou implante um na sua conta.
- [Revisar um pull request com a equipe](github.md): instale o GitHub App e escolha a política de publicação.
- [Testar uma aplicação no navegador](qa.md): configure dados sintéticos e jornadas de usuários.
- [Ajustar o que o Rio verifica](profiles.md): altere cobertura, exclusões, regras de falha e limites.

Máquina nova? Comece pela [instalação](installation.md). Algo falhou? Consulte [Solução de problemas](troubleshooting.md). Encontre todos os guias em [Guias](guides.md) e os comandos e ajustes exatos em [Referência](reference.md).

## O que executa em cada lugar?

| Recurso | CLI local | Endpoint configurado |
| --- | --- | --- |
| Tipos, lint, segredos, cobertura e grafo | Sim, com ferramentas e dependências do projeto | Runner isolado; dependências ausentes podem impedir verificações |
| Auditoria de vulnerabilidades | Acesso de rede ao OSV; registros em cache | Pode ser ignorada quando a análise não tem rede |
| Hipóteses de IA e verificação independente | Adiadas sem endpoint | Rotas de modelos e limites configurados |
| Comentários em PRs, histórico e propostas de supressão | Exigem endpoint | GitHub App e política adequada |
| QA no navegador | Exige Docker, ambiente e autenticação do modelo | Verificação hospedada e transporte de evidências |
| Documentação para agentes | Sempre offline, sem exigir repositório | Desnecessário |

`--offline` impede as requisições do próprio Rio. Ele **não** isola ferramentas e testes do projeto da rede. [Privacidade e cache](cache.md) explica o fluxo de dados.

## Sistemas suportados e estado atual

Os alvos de distribuição incluem Linux (musl), macOS e Windows em x64/arm64. TypeScript, Python e Rust têm adaptadores integrados. QA no navegador exige um host Docker com controle de firewall; a existência do executável Windows não garante qualquer configuração de host para QA. Veja os pré-requisitos de cada guia.

Estas páginas descrevem a revisão de código indicada no rodapé. Os registros de aceitação existentes não comprovam aprovação para uma versão estável; a avaliação A/B ao vivo do conselho ainda está pendente. Implementação no código, disponibilidade de uma versão publicada e qualidade validada são coisas distintas. Confira `rio --version`; a [documentação embutida](docs.md) corresponde ao executável instalado.

## Entenda os termos

Um **perfil** define a política da revisão, um **endpoint** é o coordenador hospedado, um **achado** é um problema apontado e a **evidência** expressa como ele foi demonstrado. O [Glossário](glossary.md) explica os demais termos.
