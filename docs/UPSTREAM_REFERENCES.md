# Referências upstream da Fase 02

| Origem | Revisão e licença | Uso no DevBrain |
| --- | --- | --- |
| [Models.dev](https://github.com/anomalyco/models.dev) / [API](https://models.dev/api.json) | `63a9d0be1c4ae507b1ba6482888252b1cec71240`, MIT; SHA-256 original `5e570f75704a7366d8b40652895e3d25e79e15f2f0e792176a35b33b1f65e851` | 327 candidatos em `catalog/models-dev-candidates.json`, transformados por `scripts/sync-models-dev.mjs`. Entrada descoberta não é conexão ativa nem prova de gratuidade. |
| [OpenCode CLI](https://opencode.ai/docs/cli/commands/) e [provedores](https://opencode.ai/docs/providers/) | Documentação oficial consultada em 2026-11-27; sem código copiado | Adaptador CLI de descoberta e execução pelo motor operacional; configuração de gateway próprio ainda pendente. |
| [OpenAI Chat](https://developers.openai.com/api/reference/resources/chat) e [Responses](https://developers.openai.com/api/reference/resources/responses/methods/create) | Documentação oficial consultada em 2026-11-27; sem código copiado | Formatos de requisição e resposta do transporte TypeScript. |
| [Anthropic Messages](https://platform.claude.com/docs/en/api/messages) | Documentação oficial consultada em 2026-11-27; sem código copiado | Formato do transporte TypeScript. |
| [Google Gemini](https://aistudio.google.com/api-reference/generate-content) | Documentação oficial consultada em 2026-11-27; sem código copiado | Formato do transporte TypeScript. |
| [Ollama](https://docs.ollama.com/api/chat), [Generate](https://docs.ollama.com/api/generate) e [List models](https://docs.ollama.com/api/tags) | Documentação oficial consultada em 2026-11-27; sem código copiado | Transporte, descoberta de modelos, download, remoção e medição local por contadores reais de tokens/duração. |

FreeLLMAPI, Free LLM Proxy Router, LiteLLM e demais projetos citados na missão
orientaram a análise de arquitetura. Nenhum arquivo de código ou dados desses
repositórios foi incorporado nesta branch.
