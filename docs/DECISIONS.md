# Registro de decisões (ADR)

Formato: contexto, decisão, consequências. Status: `aceita`, `proposta`, `substituída por
ADR-XXXX` ou `pendente (proprietário)`. ADRs nunca são apagados.

---

## ADR-0001: monólito modular em monorepo pnpm

**Status:** aceita (2026-11-27)

**Contexto.** Três agentes trabalham em paralelo, o produto é desktop e local, e a equipe
é pequena.

**Decisão.** Um único repositório com pnpm workspaces (`apps/*`, `packages/*`), um
lockfile e pacotes TypeScript com fronteiras explícitas. Nada de microsserviços, Redis,
Kubernetes ou servidores próprios.

**Consequências.** Refatorações atravessam pacotes com facilidade. O isolamento depende da
disciplina de imports, que o ESLint e a revisão garantem.

## ADR-0002: Electron + React + TypeScript strict

**Status:** aceita

**Decisão.** Electron 44.11.1 (Node 24.22 embutido) para o desktop; React 19.1 no
renderer; TypeScript 6.0.3 em modo strict, com `noUncheckedIndexedAccess` e
`exactOptionalPropertyTypes`; electron-vite 6 + Vite 8 para o build.

**Motivos.** Electron 44 é a linha estável mais recente com patch publicado há mais de duas
semanas. A 45.x tinha patch do mesmo dia. TypeScript 7 (nativo) foi evitado porque o
`typescript-eslint` 8.x suporta só `<6.1`. React 19.1.10 era a última versão com mais de
duas semanas na data.

## ADR-0003: contratos em zod, versionados

**Status:** aceita

**Decisão.** Contratos em zod 4, em `@devbrain/contracts`, sem dependências de Node, com
`CONTRACTS_VERSION` semver e namespace IPC `devbrain:v<major>:`. Validação em runtime em
toda fronteira de confiança (IPC, banco, adaptadores).

**Consequências.** Uma única fonte para tipos e validação. Mudanças incompatíveis ficam
visíveis (ver CONTRACTS.md).

## ADR-0004: SQLite via `node:sqlite` atrás de `SqlDriver`

**Status:** aceita

**Contexto.** `better-sqlite3` exige um módulo nativo recompilado para a ABI do Electron,
fonte frequente de falhas de build em equipes paralelas. Node ≥ 22.13 e o Electron 44
(Node 24.22.2, verificado) trazem `node:sqlite` embutido (SQLite 3.53).

**Decisão.** Usar `node:sqlite` (`DatabaseSync`) por trás da interface `SqlDriver`. Os
repositórios dependem só da interface.

**Consequências.** Zero módulos nativos. Se o `node:sqlite` mostrar limitações (API ainda
marcada como release candidate no Node 24), troca-se o driver por `better-sqlite3` sem
tocar nos repositórios.

## ADR-0005: IPC por allowlist + `dispatchIpc`

**Status:** aceita

**Decisão.** O preload expõe só `window.devbrain` (`invoke` / `subscribe`). Os canais são
declarados em `IPC_CHANNELS` e validados no main por `dispatchIpc`, que é independente do
Electron e testável. Canais sem implementação respondem `UNSUPPORTED`.

## ADR-0006: comandos sem shell e pisos de aprovação

**Status:** aceita

**Decisão.** `ExecutionPayload.command` é `executable + args` (sem string de shell).
`ALWAYS_ASK_ACTIONS` define ações que nenhuma política pode auto-permitir.

## ADR-0007: segredos via `safeStorage`; contratos só com referências

**Status:** aceita

**Decisão.** `CredentialVault` com o `SecretCipher` injetado (o `safeStorage` do
Electron, DPAPI no Windows). Os contratos expõem `CredentialReference`. Sem criptografia
do SO, a operação é recusada.

**Alternativa descartada.** `keytar`: arquivado e nativo.

## ADR-0008: estratégia de testes

**Status:** aceita

**Decisão.** Vitest 5 para testes unitários e de integração. Smoke E2E sem dependências
extras (`scripts/smoke-desktop.mjs`, via CDP local). O Playwright (`_electron`) entra na
Fase 01 junto com a UI real, para não adicionar o download de browsers sem testes que o
usem.

## ADR-0009: scripts de instalação bloqueados

**Status:** aceita

**Decisão.** `allowBuilds` em `pnpm-workspace.yaml`. Todos os scripts ficam bloqueados por
padrão, e o do `electron` foi negado explicitamente, porque o binário é baixado na
primeira execução. Liberar um script exige um ADR.

## ADR-0010: licença do projeto

**Status:** pendente (proprietário)

O repositório é público, mas não tem licença. Até a decisão, aplicam-se todos os direitos
reservados. Opções: MIT ou Apache-2.0 (permissivas), AGPL-3.0 (copyleft forte),
proprietária com código visível. A escolha afeta o reaproveitamento de código de
terceiros (todos os usados hoje são MIT).

## ADR-0011: reaproveitamento do Habblaud

**Status:** aceita

**Contexto.** O Habblaud (`marmottajr/habblaud`) declara a licença MIT ("Copyright (c)
2026 Márcio Junior"). O README afirma que personagens, móveis e pisos são pixel art
gerada por código e que logo, ilustrações e quadros em `client/public/assets` foram
gerados com IA. Ele lê arquivos internos e não documentados do Claude Code.

**Decisão.**

1. O Habblaud é **referência visual e funcional**. Nesta etapa, nenhum código ou asset foi
   copiado.
2. O código pode ser reaproveitado sob a MIT, preservando o aviso de copyright em
   `THIRD_PARTY_NOTICES.md` e no cabeçalho dos arquivos derivados.
3. Os assets gerados por IA **não** serão copiados: a titularidade é incerta. Arte própria
   será gerada por código ou criada para o DevBrain.
4. O DevBrain **não** dependerá do formato interno e não documentado de arquivos de
   terceiros. As integrações usam interfaces documentadas (CLI, APIs, hooks oficiais).
5. Não se usam marcas nem elementos de jogos de terceiros (por exemplo, Habbo/Sulake).
   A inspiração é de estilo, não de cópia.

## ADR-0012: modelo de branches

**Status:** aceita

**Decisão.** `main` (estável) ← `develop` (integração) ← `phase-NN/<agente>-<área>`. As
três branches da Fase 01 partem do mesmo commit de fundação. Veja INTEGRATION.md.
