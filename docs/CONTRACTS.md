# Contratos compartilhados

Pacote: `@devbrain/contracts`. Versão atual: **0.1.0**, em `CONTRACTS_VERSION`; protocolo
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
| `ProjectService` | Cadastro e gerenciamento de projetos | Claude |
| `AgentDiscoveryService` | Descoberta de agentes, verificação de dependências, capacidades | Codex |
| `SessionService` | Inicialização e encerramento de sessões | Codex |
| `ExecutionService` | Envio de instruções, streaming, interrupção | Codex |
| `ExecutionHistoryStore` | Persistência de histórico | Claude |
| `PermissionService` | Decisão de permissão | Claude |
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
- `IPC_EVENTS`: eventos do main para o renderer (`execution.event`, `approval.requested`,
  `projects.changed`). Nome no fio: `devbrain:v1:event:<chave>`.
- `IpcRequestEnvelope { contractsVersion, correlationId, payload }` e
  `IpcResponse<T>`.
- `dispatchIpc(key, envelope, handler)`: validação completa, independente do Electron.
- `DevBrainBridge`: tipo de `window.devbrain`.

Canais disponíveis na v1:

| Canal | Implementado na Etapa 00 |
| --- | --- |
| `system.getInfo` | ✅ |
| `projects.list` / `get` / `register` / `update` / `archive` / `pickDirectory` | ✅ |
| `settings.get` / `update` | ✅ |
| `audit.list` | ✅ |
| `providers.listAdapters` / `checkDependencies` / `getCapabilities` | ⏳ Fase 01 (Codex) |
| `sessions.start` / `stop` / `listByProject` | ⏳ Fase 01 (Codex) |
| `executions.submit` / `interrupt` / `getResult` / `listEvents` | ⏳ Fase 01 (Codex + Claude) |
| `approvals.listPending` / `decide` | ⏳ Fase 01 (Claude) |

Os canais ⏳ respondem `UNSUPPORTED` até serem implementados.

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

### 0.1.0 (Etapa 00)

- Versão inicial: entidades, erros, serviços, IPC v1, SDK de provedores.
