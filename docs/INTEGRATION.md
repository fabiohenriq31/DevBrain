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
| Permissões | C | X | `PermissionService`, `assessCommand`, `evaluatePermission` |
| Credenciais | C | X (adaptadores) | `CredentialVault`, `AdapterContext.resolveCredential` |
| Adaptadores | X | C, A | `ProviderAdapter`, `AdapterDescriptor`, `providers.*` |
| Git | X | C (checkpoints), A | `GitService`, `GitStatus` |

### Montagem dos serviços no main

`createHandlers` (em `apps/desktop/src/main/ipc.ts`) recebe os serviços instanciados. Para
plugar um serviço novo:

1. Instancie-o em `apps/desktop/src/main/index.ts`, passando-o em `MainServices`.
2. Acrescente o handler da chave correspondente em `createHandlers`.
3. Amplie `scripts/smoke-desktop.mjs` para cobrir o canal.

## Solicitações entre agentes

Registre aqui os pedidos de mudança em arquivos de outro dono.

| Data | De → Para | Pedido | Status |
| --- | --- | --- | --- |
| n/a | n/a | n/a | n/a |
