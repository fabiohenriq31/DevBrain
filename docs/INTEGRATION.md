# Integração

## Branches

| Branch | Uso | Quem faz merge |
| --- | --- | --- |
| `main` | Versões estáveis e com tag | Proprietário, a partir de `develop` |
| `develop` | Integração contínua das fases | Proprietário, a partir das branches de fase |
| `phase-01/claude-core` | Bloco Claude | Claude faz push; PR para `develop` |
| `phase-01/codex-engine` | Bloco Codex | Codex faz push; PR para `develop` |
| `phase-01/antigravity-desktop` | Bloco Antigravity | Antigravity faz push; PR para `develop` |

As cinco branches partem do **mesmo commit de fundação**, cujo hash está em
`docs/PROGRESS.md`. As fases seguintes repetem o padrão `phase-NN/<agente>-<área>`.

## Ciclo

1. **Sincronize com frequência.** Rebaseie a sua branch em `develop` depois de cada merge
   (`git fetch && git rebase origin/develop`). Não faça force push em branch de outro
   agente. Na própria branch, use `--force-with-lease` somente depois de um rebase.
2. **Contratos primeiro.** Um PR de contrato vai para `develop` antes das implementações
   que dependem dele.
3. **Portão de qualidade.** Todo PR passa em `pnpm validate`. O PR lista: o que foi
   feito, os testes, as mudanças de contrato, os riscos de segurança e as solicitações a
   outros donos.
4. **Ordem de merge no fim da fase:** core → engine → desktop, salvo decisão do
   proprietário.
5. **Lockfile.** Em caso de conflito em `pnpm-lock.yaml`, aceite o de `develop` e rode
   `pnpm install`. Não edite o lockfile à mão.

## Pontos de integração da Fase 01

| Ponto | Produtor | Consumidor | Contrato |
| --- | --- | --- | --- |
| Registro de handlers IPC | X, C | A (renderer) | `IPC_CHANNELS`, `apps/desktop/src/main/ipc.ts` |
| Stream de execução | X | A | `IPC_EVENTS['execution.event']`, `ExecutionEvent` |
| Histórico de execução | C (store) | X (escrita), A (replay) | `ExecutionHistoryStore`, `executions.listEvents` |
| Aprovações | C | X (espera), A (UI) | `ApprovalService`, `approvals.*`, `approval.requested` |
| Permissões | C | X | `core.authorization` (`enforce`, `authorizeCommand`, `authorizeExecution`) |
| Credenciais | C | X (adaptadores) | `core.credentials.resolve`, `AdapterContext.resolveCredential` |
| Sessões e histórico | C | X (escrita), A (leitura) | `core.sessions`, `sessions.*`, `sessions.history` |
| Prontidão de provedores | X (evidências) | C, A | `core.providers.recordEvidence`, `providers.listConfigured` |
| Adaptadores | X | C, A | `ProviderAdapter`, `AdapterDescriptor`, `providers.*` |
| Git | X | C (checkpoints), A | `GitService`, `GitStatus` |

### Montagem dos serviços no main

Desde a Fase 01, o main sobe o **DevBrain Core** (`@devbrain/core`) em
`apps/desktop/src/main/core.ts` (`startCore()`): banco em `userData/devbrain.db`, backups,
recuperação de falhas, logger rotativo em `userData/logs`, cifra `safeStorage` e repasse
dos eventos para o renderer. `createHandlers` (em `apps/desktop/src/main/ipc.ts`) recebe
`{ core, devServerUrl }`. Para plugar um serviço novo:

1. Crie-o a partir de `core` (ou passe-o junto em `MainServices`).
2. Acrescente o handler da chave correspondente em `createHandlers`.
3. Amplie `scripts/smoke-desktop.mjs` para cobrir o canal.

### Como o motor de execução (Codex) consome o Core

Tudo abaixo é API do processo main, sem canal IPC. `core` é o `CoreServices` de
`startCore()`.

```ts
// 1. Antes de iniciar (ou mandar instrução a) um agente:
const auth = await core.authorization.authorizeExecution({ sessionId, workingDirectory });
//    auth.plan.level: 'per-action' | 'adapter-sandbox' | 'none'
//    auth.plan.sandboxMode: modo que o adaptador DEVE configurar (ex.: 'read-only')
//    auth.plan.networkAllowed, auth.limits.{maxExecutionMs,maxOutputBytes}
//    Sem enforcement verificado, exige aprovação humana por sessão (espera por padrão).
const release = await core.authorization.acquireSlot(auth.agent.id, signal);

// 2. Registrar a instrução (valida cwd real dentro do workspace; idempotente por chave):
await core.sessions.recordInstruction(request);

// 3. Para cada ação interceptada (adaptadores 'per-action'):
await core.authorization.enforce({ agentId, workspaceId, sessionId, action: 'fs.write', path });
await core.authorization.authorizeCommand({ agentId, workspaceId, sessionId, executable, args, cwd });
//    allow → segue; deny → lança PERMISSION_DENIED / PATH_OUTSIDE_SCOPE / COMMAND_NOT_ALLOWED;
//    ask → cria aprovação, emite approval.requested e espera a decisão humana.

// 4. Eventos e resultado (limites de retenção aplicados; file-change indexa arquivos):
await core.sessions.recordEvent(event);
await core.sessions.recordResult(result); // uso/custo vem do provedor, nunca estimado
release();

// 5. Evidências de provedor (a única forma de mudar a prontidão):
await core.providers.recordEvidence({ providerId, aspect: 'installed', state: 'yes', detail: 'v1.2.3' });

// 6. Segredos para o processo do agente (auditado como credential.use):
const value = await core.credentials.resolve(credentialId, { agentId, reason: 'spawn' });
```

Regras: o motor não decide permissões sozinho; não promete retomar processos mortos (no
restart, sessões órfãs viram `interrupted` e execuções abertas viram `failed` com
`INTERRUPTED`); a capacidade `enforcement` só deve ser declarada em `recordEvidence` quando
o adaptador realmente a aplica.

### Mudanças incompatíveis (contratos 0.2.0)

| Mudança | Impacto | Ação do consumidor |
| --- | --- | --- |
| `PermissionService.check(PermissionCheck)` → `evaluate` / `enforce(EvaluatePermissionInput)` | Exige `workspaceId`; caminhos são resolvidos (real path) no workspace | Codex: usar `core.authorization` (acima). Nenhuma implementação existente quebrou |
| `SessionStatus` `ended` / `suspended` depreciados | Leitura normaliza para `completed` / `interrupted` | UI (Antigravity): exibir os novos status; tratar desconhecidos como "desconhecido" |
| `ApprovalService.request` com formato reduzido | `scope` nasce `once`; `projectId` e `target` opcionais | Codex: passar `projectId` e `target` quando houver |
| Sessões: registro e ciclo de vida implementados pelo Core | X5 do PHASE_01 vira "processos da sessão" | Codex: iniciar processos a partir de `sessions.start` já registrado |
| `ConcurrencyLimiter` aplicado pelo Core (`acquireSlot`) | X4 do PHASE_01 reaproveita | Codex: chamar `acquireSlot` em vez de criar limitadores próprios |

## Solicitações entre agentes

Registre aqui os pedidos de mudança em arquivos de outro dono.

| Data | De → Para | Pedido | Status |
| --- | --- | --- | --- |
| 2026-11-27 | C → A | `apps/desktop/src/main/index.ts`: trocar `createDatabase` por `startCore()` e fechar o Core no `will-quit` (desligamento limpo). Mudança mínima, sem tocar em janela ou `webPreferences` | Feito na `phase-01/claude-core`; revisar no PR |
| 2026-11-27 | C → A | `apps/desktop/package.json` e `electron.vite.config.ts`: acrescentar `@devbrain/core` às dependências e à lista `WORKSPACE` (empacotado no main) | Feito na `phase-01/claude-core`; revisar no PR |
| 2026-11-27 | C → A | UI: aprovações (`approval.requested` / `approval.decided`), escopo `once`/`session`/`project`, limitações de enforcement (`plan.limitations`) e status `interrupted` com botão "iniciar nova sessão a partir do checkpoint" (`resumeFromSessionId`) | Aberto |
| 2026-11-27 | C → X | Usar `core.authorization`, `core.sessions.record*`, `core.providers.recordEvidence` e `acquireSlot` (seção acima) | Aberto |
