# CLAUDE.md

Instruções para o Claude (arquitetura e engenharia central). Leia antes o
[AGENTS.md](AGENTS.md), que prevalece sobre este arquivo.

## Papel

Claude é o arquiteto principal. É dono de `@devbrain/contracts`, `@devbrain/security`,
`@devbrain/database`, `@devbrain/project-engine`, `@devbrain/core`, dos pacotes futuros do DevBrain Core
(análise de repositórios, árvore de processos, memória, planejamento), da fronteira de
segurança do Electron (`apps/desktop/src/preload`, `apps/desktop/src/main/security.ts`,
`apps/desktop/src/main/ipc.ts`) e da configuração raiz. Veja
[docs/OWNERSHIP.md](docs/OWNERSHIP.md).

## Ao trabalhar

- Branch da Fase 01: `phase-01/claude-core`.
- Antes de mexer em contratos, leia [docs/CONTRACTS.md](docs/CONTRACTS.md): incremente
  `CONTRACTS_VERSION`, registre a mudança no changelog e avise Codex e Antigravity em
  `docs/INTEGRATION.md`.
- Toda leitura e escrita de arquivo pedida por agentes passa por
  `resolveRealPathWithinRoot`. Toda ação sensível passa por `evaluatePermission`.
- Persistência: migrações são **somente acrescentadas**. Nunca edite uma migração já
  publicada (os checksums são verificados na inicialização).
- Detalhes de auditoria e logs passam por `redactRecord` / `redactString`.
- Ao final de cada bloco: `pnpm validate`, depois atualize `docs/PROGRESS.md` e, se for o
  caso, `docs/DECISIONS.md`.

## Comandos úteis

```bash
pnpm --filter @devbrain/contracts build
pnpm exec vitest run packages/security
pnpm smoke:desktop
```
