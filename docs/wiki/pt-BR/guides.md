# Guias por tarefa

Escolha uma tarefa e siga seus pré-requisitos e próximos passos.

## Comece

- [Instale, atualize e remova o Rio](installation.md) — Preparação local: instale, verifique, atualize ou remova o Rio.
- [Sua primeira revisão local](review.md) — Local: escolha alterações e faça a primeira revisão sem conta.
- [Diagnostique ferramentas e preparação](doctor.md) — Diagnóstico local e do endpoint, quando configurado.
- [Entenda achados e relatórios](results.md) — Todos os fluxos: interprete evidências, verificações incompletas e códigos de saída.
- [Use o terminal interativo](tui.md) — Controles do terminal para selecionar, examinar e exportar resultados.

## Configure

- [Ajuste verificações com perfis](profiles.md) — Configuração local: selecione verificações, herança e política de falha.
- [Configure sua máquina](configuration.md) — Ajustes da máquina, variáveis de ambiente e precedência.
- [Etapas, regras, adaptadores e campos](modules.md) — Referência: módulos do pipeline, adaptadores e tabelas completas dos schemas.
- [Ajuste profundidade, tempo e uso de modelos](budgets.md) — Revisão por IA: controle profundidade, verificação e limites dos modelos.
- [Escolha provedores e rotas de modelos](providers.md) — Exige endpoint: configure credenciais de provedores e rotas de modelos.

## Hospede e colabore

- [Adicione revisão por IA: conecte ou implante](hosting.md) — Preparação de IA: conecte o endpoint da equipe ou implante na sua conta.
- [Revise pull requests com a equipe](github.md) — Exige endpoint + App: revise PRs automaticamente ou pela CLI.
- [Responda aos achados e acompanhe o histórico](feedback.md) — Exige endpoint: registre respostas e acompanhe achados entre rodadas.
- [Aplique ou recuse propostas de supressão](suppressions.md) — Exige endpoint: revise propostas antes de alterar a política do repositório.
- [Revise segurança com evidências](security.md) — IA hospedada: selecione catálogos de segurança e interprete níveis de evidência.
- [Use o conselho independente](council.md) — IA hospedada opcional: configure fornecedores independentes e leia resultados parciais.

## QA no navegador

- [Sua primeira execução de QA no navegador](qa.md) — Exige Linux com Docker + acesso a modelo: prepare e execute jornadas no navegador.
- [Mantenha jornadas e orientações dos responsáveis](qa-journeys.md) — QA: escreva, valide e sincronize jornadas e orientações.
- [Prepare dados sintéticos e serviços simulados](qa-seeds.md) — QA: crie dados sintéticos e restaure serviços/arquivos isolados.
- [Examine evidências de QA e recomendações de UX](qa-evidence.md) — QA: examine capturas, DOM, traces e estado da verificação.

## Opere e automatize

- [Use o Rio em CI e análise de código](ci.md) — Automação: escolha formatos, política de saída e envio de análise de código.
- [Entenda dados, cache e modo offline](cache.md) — Todos os fluxos: entenda os dados armazenados e os limites do modo offline.
- [Dê documentação ao agente pela CLI](docs.md) — Sempre offline: forneça respostas pequenas e compatíveis com a versão pelo executável.
- [Avalie o Rio com casos rotulados](evaluation.md) — Contribuidores: execute avaliações rotuladas e entenda critérios de qualidade pendentes.
- [Solução de problemas e perguntas frequentes](troubleshooting.md) — Encontre o sintoma, execute um diagnóstico e escolha uma correção.
- [Glossário](glossary.md) — Entenda perfis, endpoints, achados, evidências e outros termos.
- [Mantenha e publique a documentação](maintenance.md) — Contribuidores: edite, traduza, valide, capture e publique a documentação.

Tabelas de opções são geradas pelo parser da CLI em cada guia responsável. Campos de schemas e módulos ficam em [Módulos](modules.md). O comando interno `rio prepare` é exclusivo do runner, não um comando comum de usuário.
