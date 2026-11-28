# Integração

## Consolidação da Fase 02 (2026-11-27)

`phase-02/consolidation` parte da `develop` que contém a UI Antigravity e
incorpora `phase-02/claude-intelligence` por merge. A branch Claude já contém
o gateway Codex como ancestral. O Core continua dono de credenciais, sessões,
projetos e auditoria; o gateway não cria serviços paralelos para essas funções.
As decisões de privacidade de projeto passam por `ai.projectPolicy.get/save`.
As receitas específicas ficam em `packages/ai-gateway/src/profiles.ts` e não
ativam contas ou modelos. O relatório verificável está em
`docs/PHASE_02_FINAL_REPORT.md`.

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
| 2026-11-27 | C → A | UI: aprovações (`approval.requested` / `approval.decided`), escopo `once`/`session`/`project`, limitações de enforcement (`plan.limitations`) e status `interrupted` com botão "iniciar nova sessão a partir do checkpoint" (`resumeFromSessionId`) | Concluído na `phase-01/antigravity-desktop` |
| 2026-11-27 | C → X | Usar `core.authorization`, `core.sessions.record*`, `core.providers.recordEvidence` e `acquireSlot` (seção acima) | Revisado na consolidação: o motor usa todos. Adicionado `costBearing` em `authorizeExecution` (ADR-0020) |
| 2026-11-27 | X → C | Ligar `OperationalExecutionService` aos handlers de descoberta/execução, repassar `execution.event` e encerrar processos antes do Core | PR #2 revisado por A; mantido em `phase-01/antigravity-desktop` |
| 2026-11-27 | X → A | Declarar os pacotes do motor no app; revisar a UX de reconexão por `seq` | Concluído na `phase-01/antigravity-desktop` (`mergeExecutionEvents` + `TerminalPane`) |
| 2026-11-27 | X → A/C | Declarar o empacotador Windows com versão fixa, licença e instalação segura | Revisado e ampliado com `icon.ico`, `deleteAppDataOnUninstall: false` e `THIRD_PARTY_NOTICES.md` |
| 2026-11-27 | A → C | Revisar commit isolado de contratos `0.3.0` (`git.status` e `git.diff` somente leitura por `workspaceId`, diff redigido e limitado em `maxBytes`) e handlers correspondentes em `apps/desktop/src/main/ipc.ts` (incluindo gravação de evidência real de `installed` em `providers.checkDependencies`) | Revisado na consolidação. Aceito; o diff passou a ser lido de forma limitada (`diffBounded`), redigido com margem e cortado sem quebrar UTF-8; Git endurecido contra configuração do repositório (ADR-0021) |
| 2026-11-27 | A → C | `packages/database/src/repositories/permissions.ts` (`SqlitePermissionGrantRepository.list`): quando `includeInactive === true`, `params` inclui `{ now: filter.now }` sem `:now` na query SQL, fazendo `node:sqlite` lançar erro de parâmetro nomeado desconhecido (`Unexpected storage failure`). A UI usa `includeInactive: false` + `audit.list` até correção pelo dono | Corrigido na `phase-01/consolidation`: `now` só é vinculado com a cláusula que o usa; teste de regressão em `database.test.ts` e `ipc.test.ts`; a UI voltou a listar o histórico completo (`includeInactive: true`) |
| 2026-11-27 | A → C / X | Fase 02 (`apps/desktop/src/main/ipc.ts`): conectar os 30 canais `ai.*` e o repasse dos eventos `ai.inference.event` e `ai.local.pullProgress` para `webContents` durante a consolidação das branches `phase-02/codex-ai-gateway`, `phase-02/claude-*` e `phase-02/antigravity-ai-center`. A Central de IA já consome todos os contratos `0.6.0` via `callAiChannel` e reporta honestamente `UNSUPPORTED` enquanto o handler não estiver registrado | Aberto para a consolidação da Fase 02 |
| 2026-11-27 | A → X | Fase 02 (`packages/provider-sdk`): confirmar que `opencode-cli` (`OpenCode`) é registrado no `AdapterRegistry` padrão do processo `main` na consolidação; `AgentsProvidersView` já o exibe e permite configurá-lo usando os metadados oficiais (`https://opencode.ai/docs/cli/commands/`) | Aberto para a consolidação da Fase 02 |
| 2026-11-27 | X → C | Revisar contratos aditivos 0.5.0 e ajustes seguintes, migration 003 do ledger, handlers IPC em `apps/desktop/src/main/ipc.ts` e teste smoke de schema; mudanças necessárias ao gateway da Fase 02 | PR de contratos #5 publicado; implementação em `phase-02/codex-ai-gateway`, revisão pendente |
| 2026-11-27 | X → A | Revisar adições de `@devbrain/ai-gateway` ao bundle e dependências do desktop; consumir novos canais de IA no renderer | Integração técnica em `phase-02/codex-ai-gateway`; UI pendente |

## Consolidação (`phase-01/consolidation`)

Mudanças em arquivos de outros donos, todas revisáveis no PR de consolidação:

| Arquivo (dono) | Mudança | Motivo |
| --- | --- | --- |
| `packages/execution-engine` (Codex) | `buildAgentCommand`: prompt após `--` ou em `--print=`, Claude com `--verbose` e modo pelo plano, `agy` com `--mode` explícito e JSON; parsing de mensagens e uso do Claude e do Antigravity; `costBearing` | ADR-0020, ADR-0021 |
| `packages/provider-sdk` (Codex) | `costModel` `unknown` para Codex e Claude; `agy` verificado com `--help`, documentação oficial; `execute` documentado como não suportado nos adaptadores CLI | ADR-0020, ADR-0021 |
| `packages/git-engine` (Codex) | `SAFE_CONFIG` em todo comando, `--no-textconv`, `diffBounded` | ADR-0021 |
| `apps/desktop/src/main/ipc.ts` (Claude) | `git.diff` limitado e redigido com margem | ADR-0021 |
| `apps/desktop/src/renderer` (Antigravity) | Grants com `includeInactive: true`; opção "execuções SEM garantia de custo"; contagem de custo desconhecido; mensagens de `BUDGET_UNENFORCEABLE` | Correção obrigatória e ADR-0020. Layout preservado |
| `scripts/verify-real-agent.mjs` (Codex) | Verificação real parametrizada por adaptador | Validação externa |

Contratos: **0.4.0** (aditivo; ver CONTRACTS.md).

## Fase 02 — inteligência (`phase-02/claude-intelligence`)

Base: commit do gateway do Codex `4b21b98`. A branch do Antigravity foi apenas
consultada; nada dela foi incorporado.

### Para o Codex (gateway)

- **Mudanças feitas no gateway** (ponto de seleção previsto em ADR-0022):
  `DeterministicRouter` removido; `AiGateway` recebe `clock` como 4º parâmetro do
  construtor e expõe `engine` (`RoutingPolicyEngine`), `intelligence`
  (`IntelligenceStore`), `explain`, `budgetStatus`, `modelEvidence` e `runBenchmark`.
  Cada tentativa é reavaliada; falha de admissão (`QUOTA_EXCEEDED` no `reserveAll`) não
  aplica cooldown nem conta tentativa. 429/cota aplica cooldown a **todas** as rotas do
  mesmo provedor. `usage.cost` agora é preenchido quando o preço é verificado.
- **Ledger:** novo método somente leitura `QuotaLedger.windowState(quotaId)`.
  A demanda de cota por tokens de entrada deixou de ser 0 (estimativa conservadora).
- **Teste alterado:** `gateway.test.ts` › "uses the next free route when the first shared
  quota is exhausted" agora espera 0 tentativas (a rota é excluída no estágio 1) e
  verifica a explicação.
- **Segurança:** `LocalGatewayServer` rejeita `Host` diferente de `127.0.0.1:<porta>`/
  `localhost:<porta>` e qualquer cabeçalho `Origin`; aceita `context` (projeto/sessão).
  `SafeHttpTransport` passa a recusar IPv6 6to4 (`2002::/16`) e Teredo (`2001:0::/32`).
- **Pendências que continuam com o Codex (dependências, não feitas aqui):** ≥ 20
  conexões específicas validadas; OpenCode ligado ao gateway (usar
  `new LocalGatewayServer(gateway, policyId, { projectId, sessionId })` por execução);
  descoberta e atualização de catálogo; validação com 2 provedores externos reais;
  runtimes locais reais; leitura do custo reportado pelo provedor (`reportedMicros`) e
  de cabeçalhos de cota (`ai.quota.observations` ainda retorna `[]`).

### Para o Antigravity (UI)

- A elegibilidade calculada no renderer (`evaluateProviderEligibility`) e
  `prefs.projectPrivacy` em `localStorage` **não** decidem nada. Use:
  `ai.projectPolicy.get/save` (classe, provedores aprovados, orçamento),
  `ai.privacyProfiles.list/save` (fatos verificados pelo usuário),
  `ai.routes.explain` (ranking + motivos de exclusão para exibir),
  `ai.budget.status`, `ai.cost.get`, `ai.quota.forecast`, `ai.benchmark.*` (`quality` = evidência medida, somente leitura),
  `ai.context.preview`, `ai.handoff.build`.
- Toda requisição de inferência originada de um projeto deve enviar `projectId`.
- Estimativas devem aparecer como estimativas (`resetBasis`, `projectionBasis`,
  `costState`), e `BudgetStatus.enforcedBy` é sempre `devbrain` (não é limite do
  provedor).
- Conflito de numeração: ADR-0022 existe nas duas branches.

### Migração

- `004 phase-02-intelligence` (somente acréscimo): `ai_project_policies`,
  `ai_privacy_profiles`, `ai_routing_decisions`, `ai_cost_records`, `ai_benchmark_runs`.

## Fase 02 — ponte de ferramentas e agente nativo (`phase-02/agent-bridge`)

Contratos **0.8.0** (aditivos). Mudanças fora dos pacotes de Claude, registradas aqui para
revisão dos donos:

### Para o Codex (gateway e motor de execução)

- `protocols.ts`: chamadas de ferramentas em Chat Completions (incluindo `custom`),
  Anthropic Messages, Gemini e Ollama; requisição, histórico (`tool_calls`/`tool`,
  `tool_use`/`tool_result`, `functionCall`/`functionResponse`), resposta e streaming
  (`tool-call-delta`). O protocolo Responses recusa ferramentas com `UNSUPPORTED`.
- `gateway.ts`: repassa `toolCalls` no resultado e eventos `tool-call-delta` (marcam saída
  exposta: sem fallback depois disso). Argumentos de ferramenta não são persistidos no
  SQLite (só id e nome). Novos `policies()` e `freeOnly(id)`.
- `server.ts`: o `501` para ferramentas foi substituído por `translateOpenAiChat`;
  `functions`/`function_call` legados continuam `501`.
- O roteador exige `capabilities.tools` sempre que a requisição traz ferramentas ou
  histórico de ferramentas e exclui o protocolo Responses nesse caso.
- `execution-engine`: helpers de processo movidos para `process.ts` (sem mudança de
  comportamento); novo `agent-runtime.ts`; `OperationalExecutionService` aceita um terceiro
  argumento opcional (cliente do gateway) e executa o adapter `devbrain-agent` sem processo
  externo. Projeto restrito não bloqueia esse adapter no motor: o gateway restringe cada
  chamada de modelo a rotas locais.
- `provider-sdk`: novo adapter `devbrain-agent` (`http-api`, enforcement `per-action`).

### Para o Antigravity (UI)

- `WorkspaceView`: quando o agente selecionado usa `devbrain-agent`, mostra estratégia de
  roteamento (`ai.policies.list`), modelo com ferramentas ou roteamento automático, comandos
  pré-autorizados e limite de turnos; o bloqueio de projeto restrito não se aplica a esse
  adapter. Eventos `tool-call` exibem estado e resultado.
- Para usar: Central de IA → registrar o provedor "DevBrain Agent (AI Gateway)" a partir do
  catálogo de adapters e criar um agente para ele. Modelos só são elegíveis quando
  cadastrados com "ferramentas" habilitado.

### OpenCode

Decisão em ADR-0029: o OpenCode continua bloqueado fora de projeto público com custo
autorizado. A ponte HTTP agora aceita ferramentas, mas as ferramentas do OpenCode rodam
dentro do próprio OpenCode, fora da autorização do Core.
