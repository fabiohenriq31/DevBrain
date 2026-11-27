# Propriedade de módulos

Cada caminho tem **um** dono. Só o dono altera o caminho na sua branch. Os outros agentes
pedem mudanças por PR pequeno com o dono como revisor ou por uma entrada em
`docs/INTEGRATION.md` (seção "Solicitações").

Legenda: **C** = Claude · **X** = Codex · **A** = Antigravity · **P** = Proprietário.

## Pacotes e app

| Caminho | Dono | Revisão obrigatória |
| --- | --- | --- |
| `packages/contracts/**` | C | X e A, quando o contrato afeta o pacote deles |
| `packages/security/**` | C | n/a |
| `packages/database/**` | C | n/a |
| `packages/project-engine/**` | C | n/a |
| Pacotes futuros do Core (`repo-analyzer`, `knowledge`, `planner`) | C | n/a |
| `packages/provider-sdk/**` | X | C (interface pública) |
| `packages/execution-engine/**` | X | C (segurança) |
| `packages/git-engine/**` | X | n/a |
| Pacotes futuros (`orchestrator`, adaptadores) | X | C |
| `packages/ui/**` | A | n/a |
| Pacotes futuros de visualização (`office`, grafos) | A | n/a |
| `apps/desktop/src/renderer/**` | A | n/a |
| `apps/desktop/src/main/index.ts` (janela, ciclo de vida) | A | C (webPreferences) |
| `apps/desktop/src/main/security.ts` | C | n/a |
| `apps/desktop/src/main/ipc.ts` (registro de handlers) | C | Cada dono acrescenta os handlers dos próprios serviços, num PR revisado por C |
| `apps/desktop/src/preload/**` | C | n/a |
| `apps/desktop/electron.vite.config.ts` | A | C (CSP) |
| `apps/desktop/package.json`, `tsconfig.*.json` | A | n/a |
| `resources/**` | A | n/a |

## Raiz e infraestrutura

| Caminho | Dono | Observação |
| --- | --- | --- |
| `package.json` (raiz), `pnpm-workspace.yaml` | C (integrador) | Pedidos de mudança por PR |
| `pnpm-lock.yaml` | C (integrador) | Cada agente regenera na própria branch; conflitos resolvidos em `develop` |
| `tsconfig.base.json`, `tsconfig.json`, `tsconfig.test.json` | C | |
| `eslint.config.js`, `.prettierrc.json`, `.editorconfig`, `.gitattributes` | C | |
| `.gitignore`, `.npmrc` | C | Remover entradas de segurança exige ADR |
| `vitest.config.ts`, `tests/integration/**` | C | Testes de integração de X e A podem ser acrescentados em subpastas próprias |
| `scripts/check-secrets.mjs` | C | |
| `scripts/smoke-desktop.mjs` | C | A pode ampliar os casos de UI |
| `scripts/**` (demais), `.github/workflows/**`, empacotamento | X | |
| `.github/**` (configurações de repositório) | P | Visibilidade, proteções e segredos do GitHub só com o proprietário |

## Documentação

| Caminho | Dono |
| --- | --- |
| `AGENTS.md`, `docs/MASTER_PLAN.md`, `docs/OWNERSHIP.md` | C, com aprovação de P |
| `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md`, `docs/SECURITY.md` | C |
| `docs/DECISIONS.md` | Todos acrescentam ADRs; ninguém edita ADR alheio |
| `docs/PROGRESS.md`, `docs/INTEGRATION.md` | Cada agente edita a sua seção |
| `docs/PHASE_01.md` | C (cada bloco pode atualizar o status das suas entregas) |
| `CLAUDE.md` | C |
| `CODEX.md` / instruções do Codex (quando houver) | X |
| `ANTIGRAVITY.md` / instruções do Antigravity (quando houver) | A |
| `README.md`, `THIRD_PARTY_NOTICES.md` | C, com contribuição de todos |
