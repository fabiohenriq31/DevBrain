# Fase 01: relatório final de consolidação

Branch: `phase-01/consolidation`, criada a partir de `phase-01/antigravity-desktop`
(`bc6377a`), que já continha o histórico dos três agentes (Claude, Codex e Antigravity) e
o commit de contratos `3d43e24`. Nada foi reimplementado: a consolidação corrige,
endurece e valida o que os três blocos entregaram.

Data: 2026-11-27. Build: **desenvolvimento, não assinada**.

## 1. Funcionalidades entregues

- **Projetos:**
  - importar ou criar pasta, detectar Git e branch, tecnologias;
  - configurações e diretórios autorizados por projeto, recentes, arquivar e restaurar;
  - remover só o registro (nunca os arquivos);
  - exportar em JSON.
- **Provedores e agentes:** Codex, Claude Code e Antigravity CLI. A prontidão depende
  apenas de evidência do motor (executável encontrado e executado, execução concluída).
  Não existe canal para o renderer declarar evidência.
- **Credenciais:** `safeStorage`/DPAPI. Só texto cifrado no SQLite, e o valor nunca volta
  ao renderer.
- **Sessões e execuções:**
  - instruções, streaming ordenado por `seq` e persistido;
  - terminal xterm somente leitura e sanitizado;
  - cancelamento gracioso ou forçado da árvore de processos e timeout;
  - detecção de arquivos alterados, checkpoint estruturado, histórico;
  - nova sessão consciente a partir de uma sessão `interrupted`.
- **Permissões:**
  - políticas por agente e projeto, com plano de enforcement por integração;
  - aprovação humana por sessão quando não há enforcement;
  - grants com escopo `session`/`project`, expiração e revogação;
  - auditoria append-only.
- **Orçamento:** tetos globais e por política. Custo desconhecido nunca vale zero
  (ADR-0020).
- **Git:** `git.status` e `git.diff` somente leitura, redigidos e limitados.
- **Recuperação:** queda detectada na inicialização seguinte. Sessões viram `interrupted`
  e execuções viram `failed`/`INTERRUPTED`. Processos mortos não são "retomados".
- **Desktop:** shell Windows, onboarding, configurações, central de segurança, workspace,
  paleta de comandos e instalador NSIS.

## 2. Arquitetura (resumo)

```
renderer (React, sandbox, sem Node) --window.devbrain (preload congelado)--> IPC v1 validado (zod, contrato 0.4.0)
  main: ipc.ts (remetente confiável: frame de topo + origem do app)
    ├─ @devbrain/core: projetos, provedores, credenciais, sessões, autorização, aprovações, uso, manutenção
    │    └─ @devbrain/database (node:sqlite, migrações somente acrescentadas) + @devbrain/security
    ├─ @devbrain/execution-engine: OperationalExecutionService (único caminho de execução)
    │    ├─ core.authorization.authorizeExecution / authorizeCommand / acquireSlot
    │    ├─ core.sessions.recordInstruction / recordEvent / recordResult / saveCheckpoint
    │    └─ @devbrain/provider-sdk (descoberta e capacidades) + buildAgentCommand
    └─ @devbrain/git-engine: LocalGitService (status, diff limitado, worktrees)
```

Ordem de desligamento: `before-quit` encerra o motor (abort, kill da árvore, espera dos
resultados) e só depois fecha o Core. O teste do instalador confirma um fechamento limpo,
sem sinal de queda na reabertura.

## 3. Compatibilidade com provedores

| Provedor | Executável | Linha de comando (ADR-0021) | Enforcement declarado | Custo | Estado nesta máquina |
| --- | --- | --- | --- | --- | --- |
| OpenAI Codex | `codex` | `exec --json --sandbox <read-only\|workspace-write> -C <cwd> -- <prompt>` | `none` no Windows e `adapter-sandbox` nos demais | `unknown` | Instalado só dentro da extensão do VS Code, fora do `PATH`. Autenticado por conta ChatGPT. **Validado de ponta a ponta** |
| Claude Code | `claude` | `-p --output-format stream-json --verbose --permission-mode <plan\|acceptEdits> -- <prompt>` | `none` | `unknown` | Binário 2.1.299 do app desktop da Anthropic, fora do `PATH`. **Não autenticado** para uso standalone: flags aceitas, falha de autenticação reportada |
| Google Antigravity CLI | `agy` | `--output-format json --mode <plan\|accept-edits> --print-timeout <n>s --print=<prompt>` | `none` | `unknown` | **Não instalado.** Só o IDE Antigravity está presente; ele não é o CLI `agy` |

As flags do `agy` foram conferidas na documentação oficial (`antigravity.google/docs/cli`):
modo headless `--print`, `--output-format json`, `--mode` e `--print-timeout`. O `agy` não
documenta `--version`, então a presença é verificada com `--help` e a versão fica
desconhecida. O caminho do Antigravity **não foi executado** nesta máquina.

`ProviderAdapter.execute` dos adaptadores CLI lança `UNSUPPORTED`, e isso está documentado
no SDK. O único caminho anunciado e suportado é `OperationalExecutionService`, que é o que
os canais `executions.*` usam.

## 4. Evidência de execução real

Script `scripts/verify-real-agent.mjs <adapterKey>`. É manual, nunca roda em CI e usa um
projeto Git temporário novo em `%TEMP%`.

**Codex** (`codex-cli 0.169.0-alpha.11.1`, assinatura ChatGPT, nenhuma chave de API):

| Etapa | Resultado |
| --- | --- |
| Descoberta e capacidades | `available`, versão real, `enforcement: none`, `costModel: unknown` |
| Orçamento com teto e custo desconhecido | Bloqueado antes de iniciar: `BUDGET_UNENFORCEABLE`, `startedAt: null` |
| Aprovação | Pedido `process.spawn` por sessão (sem enforcement), aprovado com escopo de sessão |
| Alteração real | `counter.js` recebeu `triple(n)`, status `completed` e exit code 0 |
| Streaming e persistência | 22 eventos transmitidos = 22 persistidos (`status`, `output`, `message`, `file-change`, `usage`) |
| Detecção de mudanças | `file-change` de `counter.js`. O diff Git contém `triple` |
| Alteração prévia do usuário | `notes.md`, não commitado, preservado byte a byte e não atribuído ao agente |
| Resultado, checkpoint e histórico | 3 execuções e 2 checkpoints na sessão |
| Cancelamento | Segunda execução real interrompida em modo gracioso: `cancelled` |
| Uso | 85.216 tokens de entrada e 357 de saída. Custo `null` e `unknownCostExecutions: 2` (não tratado como zero) |

**Claude Code:** descoberta `available` (2.1.299). As flags foram aceitas: o evento `init`
de `stream-json` chegou. A execução terminou como `failed` porque o CLI standalone não
está autenticado. Não foi simulado sucesso, e nenhuma API paga foi usada.

**Antigravity CLI:** não instalado. Fica registrado como limitação e não foi executado.

## 5. Testes e validação consolidada (bateria única)

| Verificação | Resultado |
| --- | --- |
| `pnpm validate`: typecheck, lint, format, Vitest, secret scan, build desktop, smoke | ✅ Passou. **122 testes em 14 arquivos**; smoke com **37 verificações**, incluindo morte do processo e reinício |
| Regressão do grant (`includeInactive`) | ✅ `database.test.ts` e `ipc.test.ts` |
| Regressão do orçamento com custo desconhecido | ✅ `core.test.ts`, `compat.test.ts` (0.4.0) |
| Prompt não vira flag e modos sem autoaprovação | ✅ `engine.test.ts` (`buildAgentCommand`) |
| `fsmonitor`/`textconv` maliciosos não executam; diff truncado sem quebrar UTF-8 | ✅ `git.test.ts` |
| Build de produção e empacotamento NSIS | ✅ `dist:win` |
| Smoke contra o app **instalado** (sem dev server) | ✅ `SMOKE OK` |
| Instalação silenciosa por usuário, perfil temporário, registro de projeto, fechamento limpo, reabertura com persistência | ✅ Contrato 0.4.0, `integrity ok`, saída 0, projeto presente e `uncleanShutdownDetected: false` |
| Desinstalação | ✅ Arquivos, registro e atalhos removidos. Banco do perfil e projeto **preservados**. `%APPDATA%\DevBrain AI` real não existia e não foi tocado |
| Fluxo real de agente | ✅ Codex · ⚠️ Claude Code bloqueado por autenticação · ⏸️ Antigravity não executado (não instalado) |
| CI no GitHub | ⏸️ Não executado nesta consolidação |
| Navegação visual manual de cada tela | ⏸️ Não executada. Coberto por automação: montagem da UI, tema, terminal, canais de aprovação, Git, execução e recuperação no smoke, mais 9 testes do renderer |

## 6. Correções da consolidação

1. **`GrantRepository.list`:** `now` era vinculado sem `:now` no SQL quando
   `includeInactive` era verdadeiro, e o `node:sqlite` rejeitava. Agora o valor só é
   vinculado junto com a cláusula que o usa. Há teste de regressão, a UI voltou a listar o
   histórico completo e o contorno foi removido.
2. **Custo desconhecido não é zero (ADR-0020, contrato 0.4.0):**
   - contabilização de execuções sem custo, inclusive as interrompidas por queda;
   - `BUDGET_UNENFORCEABLE`;
   - consentimento explícito `allowWithoutCostGuarantee`, rotulado na UI;
   - `unknownCostExecutions` exibido;
   - o `maxPerExecution` da política, que antes não era aplicado, agora também conta como
     teto não garantido.
3. **Injeção de flags pelo prompt (ADR-0021):** o prompt vai depois de `--` ou como
   `--print=<prompt>`.
4. **Claude Code:** faltava `--verbose`, exigido por `stream-json` em `-p`. O modo
   `default` negava edições; agora o modo vem do plano (`plan` ou `acceptEdits`).
   Mensagens do assistente e tokens passaram a ser lidos.
5. **Antigravity:** o modo headless padrão (`auto`) foi substituído por um modo explícito.
   A saída agora é JSON com sucesso só por `status: "SUCCESS"`; antes, qualquer texto
   valia como sucesso. A presença é verificada com `--help`.
6. **Git:** `core.fsmonitor`/`diff.external` desligados e `--no-textconv`. Um diff acima de
   8 MiB agora é truncado em vez de falhar. Um segredo na fronteira do corte não sobrevive
   parcialmente.
7. `costModel` dos adaptadores Codex e Claude Code mudou de `subscription` para `unknown`,
   porque a cobrança depende da autenticação, que não é verificada.

## 7. Segurança e limitações operacionais

- Uma aprovação por sessão **não** é isolamento no nível do sistema operacional. Codex no
  Windows, Claude Code e Antigravity rodam com `enforcement: none`. O DevBrain confina o
  `cwd`, filtra o ambiente, exige aprovação humana e mostra as limitações, mas não
  intercepta as ações do agente.
- Os modos `read-only`, `plan` e `accept-edits` são aplicados pelos próprios CLIs, e o
  DevBrain não os verifica. Execução irrestrita nunca é o padrão, e nenhum modo de
  autoaprovação é usado.
- Nenhum adaptador informa custo. Com teto configurado, execuções de agentes são bloqueadas
  até que o usuário remova o teto ou consinta de forma explícita.
- O renderer não tem Node, o IPC é tipado e validado, e o remetente é verificado. As
  credenciais nunca voltam ao renderer. Logs e auditoria passam por redação.
- Caminhos usam real-path, inclusive junctions e symlinks. O conteúdo do agente é tratado
  como não confiável.
- Antes de iniciar o agente não há snapshot automático: alterações prévias do usuário
  ficam no disco e o agente pode editá-las. O DevBrain mostra o diff e nunca faz commit,
  reset ou push.
- Os executáveis são resolvidos **somente pelo `PATH`**. Codex e Claude Code instalados
  só dentro de outros apps (como nesta máquina) não são encontrados pelo app até que o
  usuário os coloque no `PATH`.

## 8. Instalação

Instalador: build de desenvolvimento, **não assinado**. O Windows SmartScreen pode avisar.

- Caminho: `E:\www\DevBrainAi\release\DevBrain AI Setup 0.1.0.exe`
- SHA-256: `F5DB492DA22E4C36EA4E6153250DFE707FFC8587F2AC9D8B61630151221E2A22`
- Tamanho: 120.669.825 bytes
- O instalador é por usuário e permite escolher a pasta. Ele não apaga
  `%APPDATA%\DevBrain AI` ao desinstalar.
- Para gerar de novo: `pnpm install`, depois `pnpm --filter @devbrain/desktop dist:win`
  (saída em `release/`, ignorada pelo Git).

O instalador não é publicado no repositório. O SHA-256 vale para o arquivo gerado nesta
consolidação.

## 9. Hash final e Pull Request

- Branch publicada: `phase-01/consolidation`.
- O hash final do commit de entrega fica no histórico da branch e no relatório de
  entrega.
- PR: o `gh` não está disponível nesta máquina. Abra pelo link de comparação
  <https://github.com/fabiohenriq31/DevBrain/compare/develop...phase-01/consolidation?expand=1>.
- Os PRs anteriores (#1 e #2) foram mantidos abertos e sem alteração.

## 10. Pendências não bloqueantes

- Validar Claude Code autenticado e instalar e validar o `agy` real.
- Executar o CI no GitHub para a branch de consolidação.
- Fazer a navegação visual manual completa no instalador.
- Assinar o código do instalador.
- Definir a licença do projeto (ADR-0010).
- Oferecer, opcionalmente, um snapshot ou worktree antes de cada execução, para proteger
  alterações do usuário.

## 11. Recomendações para a Fase 02

- Enforcement por ação via proxy de ferramentas (MCP) para os agentes que o suportem, para
  sair de `enforcement: none`.
- Execução em worktree isolado por padrão, com merge revisado.
- Isolamento no nível do SO (usuário restrito ou AppContainer) antes de qualquer modo
  autônomo.
- Leitura de custo de provedores que o informem de fato (APIs metered) e só então permitir
  orçamento garantido.
- Descoberta configurável de executáveis fora do `PATH`, com confirmação do usuário.
- Análise de repositórios e memória compartilhada sobre os checkpoints estruturados já
  persistidos.
