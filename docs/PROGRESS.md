# Progresso

Legenda: ✅ implementado e testado · 🟡 parcial · ⏳ planejado · ❌ bloqueado.

Commit de fundação: tag **`etapa-00-fundacao`**. Todas as branches da Fase 01 partem dele.

## Etapa 00: fundação arquitetural (2026-11-27)

| Item | Status | Evidência |
| --- | --- | --- |
| Monorepo pnpm, TypeScript strict, lockfile único | ✅ | `pnpm typecheck` |
| ESLint, Prettier, EditorConfig | ✅ | `pnpm lint`, `pnpm format:check` |
| Contratos versionados (entidades, IPC, serviços, erros) | ✅ | `packages/contracts`, 13 testes |
| Segurança: caminhos, políticas, comandos, redação, cofre, conteúdo não confiável, limites | ✅ | `packages/security`, 20 testes |
| Persistência: driver `node:sqlite`, migração 1, repositórios, auditoria append-only | ✅ | `packages/database`, 7 testes |
| Cadastro de projetos com workspace primário e auditoria | ✅ | `packages/project-engine`, 3 testes |
| SDK de provedores (interface + registry) | 🟡 | Só interface; nenhum adaptador (Fase 01, Codex) |
| Execution engine | ⏳ | Pacote reservado; `EXECUTION_ENGINE_IMPLEMENTED = false` |
| Git engine | ⏳ | Pacote reservado; `GIT_ENGINE_IMPLEMENTED = false` |
| UI tokens | 🟡 | Só tokens (Fase 01, Antigravity) |
| Shell Electron seguro (sandbox, isolamento, CSP, IPC validado) | ✅ | `pnpm smoke:desktop` (14 verificações) |
| Teste de integração IPC → serviço → SQLite | ✅ | `tests/integration`, 2 testes |
| Secret scan | ✅ | `pnpm check:secrets` |
| CI (GitHub Actions, Windows) | 🟡 | Workflow criado; ainda não executado no GitHub |
| Documentação obrigatória | ✅ | README, AGENTS, CLAUDE, docs/* |
| Branches `main`, `develop`, `phase-01/*` | ✅ | Ver INTEGRATION.md |
| Licença do projeto | ❌ | Pendente com o proprietário (ADR-0010) |

## Fase 01

### Claude: `phase-01/claude-core` (2026-11-27)

Validação: `pnpm validate` verde: typecheck, lint, format, **92 testes** em 9 arquivos,
secret scan (125 arquivos), build do desktop e smoke com **29 verificações** (inclui falha
simulada e reinício do app real).

| Item | Status | Evidência |
| --- | --- | --- |
| Persistência: migração 2 (FK em cascata, índices, tabelas novas), transações `BEGIN IMMEDIATE` + savepoints, retry em BUSY, erros tipados | ✅ | `database.test.ts` (17): upgrade de banco v1 com dados, cascata, `foreign_key_check` |
| Recuperação de arquivo: `quick_check`, quarentena, restauração de backup, recriação; backup antes de migrar e diário | ✅ | `database.test.ts` (banco corrompido), `core.test.ts` (manutenção) |
| Retenção: limites de eventos e bytes por execução, poda de eventos e auditoria protegida com SHA-256 | ✅ | `database.test.ts`, `core.test.ts` |
| Projetos: criar pasta, importar, Git/não Git, normalização real-path, tecnologias, configurações por projeto, recentes, arquivar/restaurar, remover só o registro, diretórios autorizados | ✅ | `project-service.test.ts` (9), junction no Windows |
| Provedores: cadastro, ativação, executável, credencial, modelos, preferências por projeto; prontidão só por evidência do motor | ✅ | `core.test.ts`; smoke `providerReadiness: configured` |
| Agentes com política restritiva padrão; políticas versionadas | ✅ | `core.test.ts` |
| Credenciais: `safeStorage`/DPAPI, só texto cifrado no SQLite, recusa sem criptografia, `environment`, uso auditado | ✅ | `core.test.ts`; smoke `noPlaintextSecretInDb` (bytes do `.db` e `-wal`) |
| Segurança: `checkWorkspaceAccess` real-path (junctions/symlinks), exclusões padrão e por projeto, somente leitura | ✅ | `workspace-access.test.ts` (7), `core.test.ts` |
| Autorização efetiva (`enforce`, `authorizeCommand`, `authorizeExecution`), política do projeto, grants com escopo e expiração, revogação, plano de enforcement | ✅ | `core.test.ts` (6 testes de autorização) |
| Aprovações persistentes: pedido, espera, decisão, expiração, cancelamento, eventos | ✅ | `core.test.ts`; canais `approvals.*` |
| Concorrência global/por agente e orçamento diário/mensal/por agente | ✅ | `core.test.ts` |
| Sessões: estados novos, instruções, eventos, arquivos, resultados, uso, checkpoints estruturados, histórico, re-execução consciente | ✅ | `core.test.ts` |
| Recuperação de falhas: sessões `interrupted`, execuções `failed`/`INTERRUPTED`, aprovações `cancelled`, sem retomada de processos | ✅ | `core.test.ts`; smoke mata e reinicia o app (`sessionAfterCrash: interrupted`) |
| Logger rotativo com redação | ✅ | `workspace-access.test.ts` |
| 35 canais IPC novos ligados no main | ✅ | `tests/integration/core.test.ts` (valida schemas de saída), smoke |
| Contratos 0.2.0 compatíveis com dados 0.1.0 | ✅ | `compat.test.ts` (6) |
| Execução real de agentes, adaptadores CLI | ⏳ | Fora deste bloco (Codex). Canais respondem `UNSUPPORTED` |
| UI completa | ⏳ | Fora deste bloco (Antigravity) |
| C8: revisão de segurança dos PRs de Codex e Antigravity | ⏳ | Quando os PRs existirem |

### Codex: `phase-01/codex-engine`

X1 a X10: ⏳.

### Antigravity: `phase-01/antigravity-desktop`

A1 a A8: ⏳.
