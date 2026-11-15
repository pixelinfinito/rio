# Mantenha e publique a documentação

O repositório principal do Rio é a origem destas páginas; a Wiki é uma saída gerada. Atualize os dois idiomas e o tópico compacto em inglês quando o comportamento mudar. Não edite tabelas geradas de comandos/schemas manualmente.

## Fluxo local

1. Edite `docs/wiki/en/TOPIC.md`, `docs/wiki/pt-BR/TOPIC.md` e `docs/agent/TOPIC.md`, conforme necessário. Preserve comandos/chaves entre traduções.
2. Atualize `docs/documentation-manifest.json`: fontes, cobertura, relações, capturas e disponibilidade. Opções públicas precisam de descrições nos dois idiomas em `docs/argument-descriptions.json`.
3. Instale ferramentas de desenvolvimento: `python3 -m venv .venv`; `.venv/bin/pip install -r scripts/requirements-docs.txt`. Elas não são dependências de execução do Rio.
4. Exporte fatos do parser: `RIO_DOCS_INVENTORY="$PWD/docs/command-inventory.json" cargo test -p rio-cli --bin rio docs_inventory::export_documentation_inventory -- --ignored`.
5. Execute `.venv/bin/python scripts/documentation_schemas.py` e `python3 scripts/documentation.py generate`.
6. Revise significado e exemplos nos dois idiomas. Registre explicitamente com `python3 scripts/documentation.py review TOPIC_ID` para cada par afetado. Isso atesta revisão; não traduz automaticamente.
7. Execute testes/verificações e recompile antes de medir a saída embutida.

```sh
python3 scripts/documentation.py check
.venv/bin/python -m unittest discover -s tests/documentation -v
cargo test -p rio-cli --test docs
cargo build -p rio-cli --locked
.venv/bin/python scripts/documentation.py budgets
```

Guias exigem objetivo, pré-requisitos, passos, resultados esperados, solução de problemas e próximos passos. Use palavras comuns e explique termos. Referências geradas de schemas são concisas. O [Glossário](glossary.md) padroniza termos; preserve diferenças entre incompleto, não verificado e falho.

## Capturas

Execute `.venv/bin/python scripts/capture-documentation.py` no Linux com Cargo, executável compilado e fonte DejaVu Sans Mono documentada (substitua com `--font` se necessário). A ferramenta captura a CLI e buffers reais da TUI com fixtures, não protótipos antigos. Mantenha PNGs, transcrições e `captures.json` juntos. Revise legibilidade e remoção de dados privados; atualize legendas e registros de revisão. Fixtures da TUI são dados demonstrativos, inclusive versões exibidas; não indicam execução ao vivo de provedores. Imagens de saídas longas são recortes com link para transcrição completa.

## Publicação

Gere em diretório novo/vazio: `python3 scripts/documentation.py render /tmp/rio-wiki-stage`. Inspecione links/imagens e publique com `python3 scripts/publish-wiki.py /tmp/rio-wiki-stage --remote https://github.com/pixelinfinito/rio.wiki.git`, usando o gerenciador de credenciais Git existente. A primeira publicação pode adotar uma Home provisória inspecionada com `--adopt Home.md`.

O GitHub precisa da Wiki habilitada e uma primeira página salva. Use credencial com escrita na Wiki; não presuma que o token padrão do Actions funciona. O workflow manual usa segredo dedicado. Falta de acesso/inicialização interrompe publicação e preserva os arquivos. O publicador preserva páginas alheias, rejeita alterações inesperadas em arquivos gerenciados, verifica concorrência e nunca força push. Conteúdo inalterado não cria commit.

Depois, verifique Home, índices dos dois idiomas, barra lateral, trocas de idioma, âncoras e imagens. Registre commits de origem e Wiki. Reverta pelo Git em uma cópia da Wiki e envie normalmente, ou gere/publique uma revisão anterior revisada. Não sobrescreva alterações intermediárias de outro mantenedor.

[Volte à Referência](reference.md).

[Modelos de autoria](../../templates/guide-pt-BR.md): guias/referências nos dois idiomas e modelo compacto para agentes ficam em `docs/templates/`. Configure `RIO_WIKI_TOKEN` para o workflow manual **Publish Wiki**; publique um commit revisado e enviado ao repositório. A validação de releases testa a documentação embarcada nos artefatos instalados.
