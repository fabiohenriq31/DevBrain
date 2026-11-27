# Contratos compartilhados

Pacote: `@devbrain/contracts`. Versão atual: **0.4.0**, em `CONTRACTS_VERSION`; protocolo
IPC **v1**, em `IPC_PROTOCOL_VERSION`.

Os contratos são a única interface entre os módulos dos três agentes. São escritos em
zod, o que dá tipos estáticos (`z.infer`) e validação em runtime nas fronteiras de
confiança.

## Inventário

### Entidades

| Contrato | Arquivo | Observações |
| --- | --- | --- |
| `Project`, `Workspace`, `WorkspaceAccessPolicy` | `entities/project.ts` | Workspace `git-worktree` isola código, não segurança |
| `Provider`, `ProviderKind`, `ProviderStatus`, `AdapterDescriptor` | `entities/provider.ts` | `endpoint` rejeita credenciais embutidas |
| `AgentCapabilities`, `NO_CAPABILITIES` | `entities/provider.ts` | Só capacidades verificadas |
| `DependencyCheck`, `DependencyReport` | `entities/provider.ts` | Verificação de dependências instaladas |
| `Agent`, `AgentSession`, `SessionStatus` | `entities/agent.ts` | |
| `ExecutionRequest`, `ExecutionPayload` (`prompt` / `command`) | `entities/execution.ts` | Comando = executável + args, **sem shell** |
| `ExecutionEvent` (união discriminada por `type`) | `entities/execution.ts` | `seq` monotônico; texto é não confiável |
| `ExecutionResult`, `ExecutionStatus`, `EXECUTION_TRANSITIONS` | `entities/execution.ts` | Resultado exige status terminal |
| `PermissionPolicy`, `PermissionRule`, `PermissionAction`, `ExecutionLimits`, `Budget` | `entities/permissions.ts` | |
| `ALWAYS_ASK_ACTIONS` | `entities/permissions.ts` | Nunca auto-permitidas |
| `ApprovalRequest`, `ApprovalDecisionInput` | `entities/permissions.ts` | `decidedBy` só pode ser `user` |
| `CredentialReference` | `entities/records.ts` | Só referência (`locator`), nunca valor |
| `GitRepository`, `GitStatus`, `GitRemote`, `GitWorktree` | `entities/records.ts` | Remotes sem credenciais |
| `Checkpoint` | `entities/records.ts` | Estado versionado e neutro em relação ao provedor |
| `AuditEvent`, `AuditActor` | `entities/records.ts` | Append-only; detalhes redigidos |
| `ApplicationSettings`, `SettingsPatch`, `DEFAULT_SETTINGS` | `entities/records.ts` | `telemetry: false` literal |
| `RetentionSettings`, `DEFAULT_RETENTION` (0.2.0) | `entities/records.ts` | Limites de eventos, saída, auditoria, logs e backups |
| `Technology`, `CreateProjectInput`, `RemoveProjectInput`, `ProjectSettings(Patch)`, `UpdateWorkspaceAccessInput` (0.2.0) | `entities/project.ts`, `entities/core.ts` | `remove` exige `confirm: true` e nunca apaga arquivos |
| `ProviderConfig`, `Evidence`, `ProviderHealth`, `ProviderReadiness`, `ProviderProfile` (0.2.0) | `entities/core.ts` | Prontidão derivada só de evidências do motor de execução |
| `EnforcementLevel` (0.2.0) | `entities/provider.ts` | `per-action` / `adapter-sandbox` / `none`; ausente = `none` |
| `StoreCredentialInput` (0.2.0) | `entities/core.ts` | Valor só entra (renderer → main); nunca volta |
| `SessionFile`, `ExecutionRecord`, `SessionHistory`, `CheckpointStateV1`, `SaveCheckpointInput` (0.2.0) | `entities/core.ts` | Checkpoint estruturado, base da memória compartilhada |
| `ApprovalScope`, `PermissionGrant`, `EvaluatePermissionInput`, `PermissionVerdict` (0.2.0) | `entities/permissions.ts`, `entities/core.ts` | Grants só elevam `ask`; nunca `deny` nem `ALWAYS_ASK` |
| `UsageSummary`, `UsageRecordInput` (0.2.0) | `entities/core.ts` | Custos informados pelo provedor; nada é estimado |
| `StorageHealth`, `BackupResult`, `PruneResult`, `ProjectExport` (0.2.0) | `entities/core.ts` | Saúde do banco e recuperação |

### Erros

`DevBrainError(code, message, { details, retryable })` e `DevBrainErrorPayload` (para a
transmissão). Os códigos estáveis ficam em `ErrorCodeSchema`. Por exemplo, `NOT_FOUND`,
`PERMISSION_DENIED`, `APPROVAL_REQUIRED`, `PATH_OUTSIDE_SCOPE`, `QUOTA_EXCEEDED`,
`RATE_LIMITED`, `UNSUPPORTED` e `CONTRACT_VERSION_MISMATCH`.

- `toErrorPayload` converte erros desconhecidos em `INTERNAL` com a mensagem genérica,
  para que nada vaze.
- `parseOrThrow(schema, value)` converte uma falha de validação em `VALIDATION_FAILED`.
- `Result<T>`, `ok()` e `err()` atendem APIs internas que preferem não lançar exceções.

### Serviços (`services.ts`)

| Interface | Cobre | Dono |
| --- | --- | --- |
| `ProjectService` | Cadastro e gerenciamento de projetos (ampliado em 0.2.0) | Claude |
| `AgentDiscoveryService` | Descoberta de agentes, verificação de dependências, capacidades | Codex |
| `SessionService` | Registro e ciclo de vida de sessões (`@devbrain/core` `SessionManager`); processos ficam com o motor | Claude (registro) / Codex (processos) |
| `ExecutionService` | Envio de instruções, streaming, interrupção | Codex |
| `ExecutionHistoryStore` | Persistência de histórico | Claude |
| `PermissionService` | `evaluate` + `enforce` (0.2.0, **incompatível** com o `check` da 0.1.0) | Claude |
| `ApprovalService` | Aprovação de ações sensíveis | Claude (UI: Antigravity) |
| `AuditLog`, `SettingsStore`, `CheckpointStore` | Auditoria, configurações, checkpoints | Claude |
| `GitService` | Repositórios, status, worktrees | Codex |

### SDK de provedores (`@devbrain/provider-sdk`)

`ProviderAdapter` (`checkDependencies`, `getCapabilities`, `startSession`, `execute`,
`endSession`), `AdapterRun` (`events: AsyncIterable`, `result`, `interrupt`),
`AdapterContext` (`resolveCredential`, `log`) e `ProviderRegistry`.

### IPC (`ipc.ts`)

- `IPC_CHANNELS`: mapa `chave → { request, response, description }`. Nome no fio:
  `devbrain:v1:<chave>`.
- `IPC_EVENTS`: eventos do main para o renderer (`execution.event`, `approval.requested`, `approval.decided`, `sessions.changed`, `providers.changed`,
  `projects.changed`). Nome no fio: `devbrain:v1:event:<chave>`.
- `IpcRequestEnvelope { contractsVersion, correlationId, payload }` e
  `IpcResponse<T>`.
- `dispatchIpc(key, envelope, handler)`: validação completa, independente do Electron.
- `DevBrainBridge`: tipo de `window.devbrain`.

Canais disponíveis na v1:

| Canal | Status |
| --- | --- |
| `system.getInfo` / `storageHealth` / `backup` | ✅ |
| `projects.list` / `get` / `register` / `create` / `update` / `archive` / `restore` / `remove` | ✅ |
| `projects.listRecent` / `markOpened` / `detectTechnologies` / `getSettings` / `updateSettings` / `export` / `pickDirectory` | ✅ |
| `workspaces.list` / `updateAccess` | ✅ |
| `providers.listConfigured` / `get` / `register` / `update` / `setEnabled` / `remove` | ✅ |
| `agents.list` / `register` / `update` | ✅ |
| `credentials.list` / `store` / `remove` | ✅ (valores nunca saem do main) |
| `sessions.start` / `stop` / `get` / `list` / `listByProject` / `history`, `checkpoints.get` | ✅ (registro; não inicia processos) |
| `permissions.listPolicies` / `savePolicy` / `listGrants` / `revokeGrant` / `evaluate` | ✅ |
| `approvals.listPending` / `decide` | ✅ |
| `executions.getResult` / `listEvents` | ✅ (histórico persistido) |
| `usage.summary`, `settings.get` / `update`, `audit.list` | ✅ |
| `git.status` / `git.diff` (0.3.0) | ✅ somente leitura; workspace por id, diff redigido e limitado |
| `providers.listAdapters` / `checkDependencies` / `getCapabilities` | ⏳ Fase 01 (Codex) |
| `executions.submit` / `interrupt` | ⏳ Fase 01 (Codex) |

Os canais ⏳ respondem `UNSUPPORTED` até serem implementados.

**APIs só do main (sem canal IPC, de propósito):** `ProviderService.recordEvidence`
(evidências de instalação, autenticação e operação), `CredentialService.resolve` (valor do
segredo, auditado), `AuthorizationService.enforce` / `authorizeCommand` /
`authorizeExecution` / `acquireSlot` e `SessionManager.recordInstruction` / `recordEvent` /
`recordResult` / `saveCheckpoint`. O renderer não consegue declarar um provedor disponível
nem decidir permissões por conta própria.

## Regras de versionamento

| Mudança | Classe | Exigências |
| --- | --- | --- |
| Campo opcional novo, valor de enum novo, canal ou evento novo, código de erro novo | **MINOR** | Bump de `CONTRACTS_VERSION`, changelog abaixo |
| Mensagem de validação ou documentação | **PATCH** | Changelog |
| Remover ou renomear campo, tornar obrigatório, estreitar tipo, remover enum ou canal, mudar semântica | **MAJOR** | ADR aprovado, novo namespace IPC (`devbrain:v2:*`), período de convivência, migração |

Enquanto a versão for `0.x`, mudanças incompatíveis são permitidas **apenas** com ADR,
aviso em `docs/INTEGRATION.md` e atualização simultânea de todos os consumidores no mesmo
PR de integração. Nunca de forma silenciosa.

Processo:

1. Abra um PR `contracts: …` que altera só `packages/contracts` (mais os testes).
2. Faça o bump de `CONTRACTS_VERSION` e acrescente a entrada no changelog.
3. Claude revisa. Os consumidores afetados são citados no PR.
4. Depois do merge em `develop`, cada agente rebaseia a sua branch.

Consumidores **devem** aceitar valores de enum desconhecidos de forma tolerante quando
isso fizer sentido (por exemplo, exibir "desconhecido" na UI). O main recusa um renderer
com major diferente (`CONTRACT_VERSION_MISMATCH`).

## Changelog

### 0.4.0 (Fase 01, consolidação)

Aditivo. Payloads gravados pela 0.3.0 continuam válidos (campos novos têm `.default()`);
ver `packages/contracts/src/compat.test.ts`.

- `ApplicationSettings.budget.allowWithoutCostGuarantee` (padrão `false`) e o mesmo campo
  opcional em `SettingsPatch.budget`: consentimento explícito para rodar execuções de
  agentes cujo custo não é informado enquanto há um teto configurado.
- `UsageSummary.unknownCostExecutions` (padrão `0`): execuções do período sem custo
  informado. Quando for maior que zero, `cost` é apenas um limite inferior.
- `ErrorCode`: `BUDGET_UNENFORCEABLE`, quando há teto financeiro e a integração não
  informa custo, de modo que o teto não pode ser aplicado.
- Motivo: regra da consolidação "custo desconhecido não equivale a custo zero" (ADR-0020).

### 0.3.0 (Fase 01, bloco Antigravity, aguardando revisão de Claude e Codex)

Aditivo. Nenhum payload existente muda.

- Canais `git.status` (`GitWorkspaceInput` → `GitStatus | null`) e `git.diff`
  (`GitDiffInput` → `GitDiff`). O renderer informa só o `workspaceId`; o main resolve a raiz
  pelo Core e apenas lê o repositório (`LocalGitService.status` / `diff`). O diff é
  redigido no main, limitado por `maxBytes` (padrão 2 MiB, máximo 8 MiB) e marcado com
  `truncated`. Nenhum canal escreve no Git.
- Motivo: a tela de execução precisa exibir o estado Git e as diferenças produzidas pelo
  motor (missão da Fase 01, A3), e o motor ainda não expunha esses dados por IPC.

### 0.2.0 (Fase 01, bloco Claude)

Aditivo, exceto onde marcado. Payloads gravados pela 0.1.0 continuam válidos (campos novos
têm `.default()`); ver `packages/contracts/src/compat.test.ts`.

- Entidades novas em `entities/core.ts` (projetos, provedores, credenciais, sessões,
  grants, uso, manutenção) e os campos novos listados no inventário.
- `Project`: `technologies`, `lastOpenedAt`. `AgentSession`: `title`, `endReason`,
  `resumedFromSessionId`, `updatedAt`. `ApprovalRequest`: `projectId`, `scope`, `target`.
  `ApprovalDecisionInput`: `scope`, `grantTtlMs`. `AgentCapabilities`: `enforcement`.
  `ApplicationSettings`: `execution.maxConcurrentPerAgent`, `security.defaultGrantTtlMs`,
  `retention`, `budget`.
- `SessionStatus`: novos `completed`, `cancelled`, `interrupted`. `ended` e `suspended`
  ficam **depreciados**: aceitos na leitura (normalizados para `completed` e
  `interrupted`), nunca produzidos.
- `ErrorCode`: `INTERRUPTED`, `STORAGE_ERROR`, `BUDGET_EXCEEDED`. Prefixo de id `grt`.
- 35 canais IPC novos (57 no total; tabela acima) e eventos `approval.decided`, `sessions.changed`,
  `providers.changed`.
- `patchOf(schema)`: schemas de patch não injetam defaults.
- **Incompatível:** `PermissionService.check(PermissionCheck)` foi substituído por
  `evaluate` / `enforce(EvaluatePermissionInput)`, que exigem `workspaceId`. Nenhum
  consumidor implementado usava a interface antiga. Ver INTEGRATION.md.
- `ApprovalService.request` recebe o formato reduzido (`NewApprovalInput`).
- Correção: `AbsolutePathSchema` aceita `C:/` e `C:\`.

### 0.1.0 (Etapa 00)

- Versão inicial: entidades, erros, serviços, IPC v1, SDK de provedores.
