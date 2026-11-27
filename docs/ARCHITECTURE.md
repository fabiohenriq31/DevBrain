# Arquitetura

## Visão geral

O DevBrain AI é um **monólito modular** executado inteiramente na máquina do usuário. Ele
roda num processo Electron com três contextos de execução e um conjunto de pacotes
TypeScript com responsabilidades bem separadas.

```
┌──────────────────────────────── Electron ────────────────────────────────┐
│ Renderer (React, sandbox, sem Node)                                       │
│   └─ window.devbrain  ← único objeto exposto (congelado)                  │
│          │ invoke(key, input) / subscribe(event)                          │
│ Preload (sandbox, CJS empacotado)                                         │
│   └─ allowlist de canais + envelope { contractsVersion, correlationId }   │
│          │ ipcRenderer.invoke("devbrain:v1:<key>")                        │
│ Main (Node) ── fronteira de confiança ──────────────────────────────────  │
│   ├─ verificação do frame remetente (origem do app, top-level)            │
│   ├─ dispatchIpc: valida envelope, versão, entrada (zod) e saída          │
│   ├─ serviços: project-engine, database, security, (execution-engine…)    │
│   └─ processos de agentes (Fase 01): spawn sem shell, cwd confinado        │
└───────────────────────────────────────────────────────────────────────────┘
          │
   %APPDATA%\DevBrain AI\devbrain.db (SQLite, WAL)
```

## Pacotes e dependências

```
contracts  ◄── security ◄── database ◄── project-engine ◄── core
    ▲             ▲             ▲              ▲              ▲
    ├── provider-sdk ◄── execution-engine ─────┴──────────────┤
    ├── git-engine                                            │
    └──────────────────────── apps/desktop (main) ────────────┘
ui ◄── apps/desktop (renderer)    (o renderer só importa contracts *tipos* e ui)
```

| Pacote | Papel | Runtime |
| --- | --- | --- |
| `contracts` | Entidades, IPC, serviços, erros, versões (zod) | Universal (sem Node) |
| `security` | Confinamento de caminhos, política de permissões, comandos, redação, cofre, limites, conteúdo não confiável | Node |
| `database` | Driver SQL, migrações com checksum, repositórios | Node (`node:sqlite`) |
| `project-engine` | `ProjectService`: criação, importação, workspaces, tecnologias, configurações por projeto, arquivamento, remoção do registro | Node |
| `core` (Fase 01) | Composição do Core: provedores (prontidão por evidência), agentes, políticas, credenciais, aprovações e grants, autorização efetiva, sessões e histórico, uso e orçamento, recuperação, manutenção (`createCoreServices`) | Node |
| `provider-sdk` | Interface `ProviderAdapter` + `ProviderRegistry` | Node |
| `execution-engine` | `SessionService` / `ExecutionService` (Fase 01) | Node |
| `git-engine` | `GitService` (Fase 01) | Node |
| `ui` | Tokens de design e, depois, componentes React | Navegador |
| `apps/desktop` | Electron: main, preload, renderer | Electron |

Regras de dependência, aplicadas por ESLint (`no-restricted-imports`) e pela revisão:

- `contracts` não importa nada além do `zod`.
- O renderer não importa `electron`, `node:*` nem pacotes de main.
- Pacotes se comunicam por interfaces de `contracts/services.ts`, nunca por internos.

## Fluxo de uma chamada

1. O renderer chama `window.devbrain.invoke('projects.register', { rootPath })`.
2. O preload confere que a chave está em `IPC_CHANNELS` e envia o envelope versionado.
3. O main confere que o remetente é o frame principal do app (`file://` em produção, a
   origem do dev server em desenvolvimento).
4. `dispatchIpc` valida o envelope, a compatibilidade de versão e a entrada (zod). Em
   seguida chama o handler e valida a saída.
5. O serviço aplica as regras de domínio e de segurança e persiste em transação, com
   auditoria.
6. A resposta volta como `IpcResponse` (`{ ok, data }` ou `{ ok: false, error }`, com
   código estável).

Canais sem handler respondem `UNSUPPORTED`. Não existem respostas simuladas.

## Execução de agentes (projeto da Fase 01)

```
ExecutionService.submit                                   (Codex)
  → core.authorization.authorizeExecution                 (Claude: sessão, cwd, orçamento,
                                                           plano de enforcement)
  → core.authorization.acquireSlot (global + por agente)
  → core.sessions.recordInstruction
  → ProviderAdapter.execute (spawn shell:false, cwd confinado, env allowlist)
      → por ação: core.authorization.enforce / authorizeCommand
      → [ask] ApprovalService.request → approval.requested → UI → decide (usuário)
  → ExecutionEvent (seq monotônico) → core.sessions.recordEvent + IPC event
  → ExecutionResult (status terminal) → core.sessions.recordResult (+ uso) + Checkpoint
```

Na inicialização, `createCoreServices` abre o banco (checagem de integridade, recuperação),
registra o `app_run` e marca como `interrupted` o que pertencia a uma instância morta.

A máquina de estados de `ExecutionStatus` está em `EXECUTION_TRANSITIONS`. Qualquer
transição fora dela é bug.

A Fase 01 roda os processos de agentes como filhos do main. A Fase 6 prevê movê-los
para um `utilityProcess` ou um processo de baixo privilégio, sem mudar contratos.

## Persistência

- SQLite via `node:sqlite` (embutido no Node/Electron, sem módulo nativo). Ver ADR-0004.
- `SqlDriver` abstrai o motor; os repositórios dependem só dele.
- Migrações só podem ser acrescentadas, cada uma com checksum. Um banco mais novo que o
  build atual é recusado.
- Colunas JSON armazenam payloads de contrato e são revalidadas na leitura.
- `audit_events` é append-only, garantido por triggers.
- Unicidade de caminhos sem diferenciar maiúsculas no Windows (`root_path_key`).
- Migração 2 (Fase 01): integridade referencial com `ON DELETE CASCADE` a partir de
  `projects` (workspaces → sessões → execuções → eventos, checkpoints, arquivos de sessão,
  grants); tabelas `project_settings`, `credential_secrets`, `session_files`,
  `permission_grants`, `usage_records`, `app_runs`, `maintenance_state`, `audit_guard`;
  índices por projeto, status e data.
- Transações: `BEGIN IMMEDIATE` com nova tentativa em `SQLITE_BUSY`; transações aninhadas
  usam savepoints. WAL com `synchronous=NORMAL` e `busy_timeout`. Erros do SQLite viram
  códigos estáveis (`ALREADY_EXISTS`, `CONFLICT`, `PERMISSION_DENIED`, `STORAGE_ERROR`).
- Arquivo: `openStorage` faz `quick_check`, coloca bancos corrompidos em quarentena,
  restaura o backup mais recente e faz backup antes de migrar.

## Configuração e dados

- Dados do usuário: `app.getPath('userData')` (`%APPDATA%\DevBrain AI`): `devbrain.db`,
  `backups/`, `corrupt/`, `logs/`.
- Configurações: tabela `settings`, validadas por `ApplicationSettingsSchema`. A
  telemetria é literalmente `false`.
- Segredos: `CredentialVault` (`safeStorage`/DPAPI) guarda só o texto cifrado. Os
  contratos carregam só `CredentialReference`.

## Testes

- Unitários (Vitest) por pacote: `packages/*/src/*.test.ts`.
- Integração entre pacotes: `tests/integration`.
- Smoke E2E do app real: `scripts/smoke-desktop.mjs`. Ele abre o Electron empacotado,
  conecta via CDP local e verifica o isolamento e o IPC reais.
- Playwright (`_electron`) entra na Fase 01 junto com a UI (ver ADR-0008).
