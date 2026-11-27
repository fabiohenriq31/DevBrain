# Fase 01: fundação operacional

**Objetivo:** o usuário instala o DevBrain no Windows, registra um projeto real, inicia uma
sessão com **um agente CLI real**, envia instruções, acompanha a saída em tempo real,
aprova ou nega ações sensíveis, interrompe a execução e retoma depois. Tudo fica
persistido e auditado.

Os três blocos rodam em paralelo, a partir do commit de fundação, cada um na sua branch.
Os pontos de encontro são os contratos de `@devbrain/contracts`.

## Bloco Claude: `phase-01/claude-core`

| # | Entrega | Critério de aceite |
| --- | --- | --- |
| C1 | `PermissionService` sobre `evaluatePermission`, com políticas persistidas (`permission_policies`) e política padrão por agente | Testes de precedência, pisos e origem não confiável |
| C2 | `ApprovalService` persistente (`approvals`): `request`, `listPending`, `decide`, `waitFor`, expiração | Aprovação expirada = negada; evento `approval.requested`; auditoria |
| C3 | Canais `approvals.listPending` e `approvals.decide` no main | Smoke cobre aprovar e negar |
| C4 | `CredentialVault` com `safeStorage` + `CiphertextStore` em SQLite + repositório de `CredentialReference` | Sem criptografia do SO = recusa; nenhum valor via IPC |
| C5 | `CheckpointStore` usado por sessões; contrato de retomada | Retomar a partir do último checkpoint em teste de integração |
| C6 | Logger estruturado com redação obrigatória (arquivo rotativo em `userData/logs`) | Nenhum segredo nos logs (teste) |
| C7 | Repositórios de `providers`, `agents`, `agent_sessions` (migração 2) | Migração nova; checksums intactos |
| C8 | Revisão de segurança dos PRs de Codex e Antigravity | Checklist de SECURITY.md aplicado |

**Status (2026-11-27):** C1 a C7 entregues em `phase-01/claude-core`, junto com o escopo
ampliado pela missão do bloco (projetos completos, provedores com prontidão por
evidência, sessões e histórico, recuperação, retenção, orçamento, concorrência). C3 está
coberto por teste de integração e smoke de listagem; o fluxo aprovar/negar ponta a ponta
no app depende da UI (A4). C8 aguarda os PRs. Detalhes e evidências em PROGRESS.md; API
para o motor em INTEGRATION.md. X4 (concorrência) e a parte de registro de X5 (sessões)
ficaram prontos no Core; o Codex os consome.

## Bloco Codex: `phase-01/codex-engine`

| # | Entrega | Critério de aceite |
| --- | --- | --- |
| X1 | `execution-engine`: `ExecutionService` com spawn `shell:false`, `cwd` confinado, `envAllowlist`, timeout, `maxOutputBytes`, kill da árvore de processos no Windows | Testes com processos reais (`node -e`) |
| X2 | Máquina de estados segundo `EXECUTION_TRANSITIONS`; eventos com `seq` monotônico; persistência via `ExecutionHistoryStore` | Replay por `executions.listEvents` idêntico ao stream |
| X3 | Integração com `PermissionService` e `assessCommand` antes do spawn; espera por aprovação (`awaiting-approval`) | `git push` só roda depois de `approvals.decide` |
| X4 | `ConcurrencyLimiter` global e por agente, a partir de `ApplicationSettings` e `ExecutionLimits` | Teste de pico de concorrência |
| X5 | `SessionService` (start/stop/listByProject) | Canais `sessions.*` funcionando |
| X6 | Primeiro(s) `ProviderAdapter` de agente CLI, **implementados a partir da documentação oficial** (registrar a URL) | `checkDependencies` real (versão detectada), capacidades verificadas |
| X7 | `AgentDiscoveryService` + canais `providers.*` | Lista adaptadores e reporta dependências ausentes |
| X8 | `git-engine`: `detect`, `status` (`--porcelain=v2 -z`), `createWorktree`, `removeWorktree` | Testes em repositório temporário |
| X9 | CI no GitHub Actions (`windows-latest`) rodando `pnpm validate` | Workflow verde em PR |
| X10 | Empacotamento Windows (electron-builder ou equivalente), instalador sem assinatura | Instalador gera app funcional |

## Bloco Antigravity: `phase-01/antigravity-desktop`

| # | Entrega | Critério de aceite |
| --- | --- | --- |
| A1 | Shell de navegação (projetos, sessões, aprovações, configurações) e roteamento | ✅ Entregue |
| A2 | Tela de projetos: registrar (seletor nativo), renomear, arquivar, ver workspaces | ✅ Entregue |
| A3 | Tela de sessão: terminal de saída (stream de `execution.event`), envio de instrução, interromper | ✅ Entregue |
| A4 | Central de aprovações: detalhes redigidos, risco, origem não confiável destacada, aprovar ou negar | ✅ Entregue |
| A5 | Configurações (idioma, tema, limites) | ✅ Entregue |
| A6 | `@devbrain/ui`: componentes base acessíveis (botão, campo, diálogo, tabela, badge de status) | ✅ Entregue |
| A7 | Smoke E2E Electron (CDP) + testes Vitest cobrindo o fluxo principal | ✅ Entregue |
| A8 | Ícones e recursos em `resources/` | ✅ Entregue |

## Integração ao final da fase

1. Merge na ordem `claude-core` → `codex-engine` → `antigravity-desktop` em `develop`,
   cada uma rebaseada sobre a anterior.
2. `pnpm validate` e o smoke ampliado (sessão real, aprovação, interrupção) em `develop`.
3. O proprietário valida o instalador e decide o merge em `main` (tag `v0.1.0`).

## Fora do escopo da Fase 01

Análise de repositórios, árvore de processos, memória, planejamento, equipes, scheduler,
provedores HTTP e modelos locais, failover, escritório virtual. Os contratos atuais já
reservam espaço para eles.
