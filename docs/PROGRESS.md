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

### Claude: `phase-01/claude-core`

C1 a C8: ⏳ (ver PHASE_01.md).

### Codex: `phase-01/codex-engine`

X1 a X10: ⏳.

### Antigravity: `phase-01/antigravity-desktop`

A1 a A8: ⏳.
