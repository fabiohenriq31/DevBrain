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

## ADR-0013: pacote `@devbrain/core`

**Status:** aceita (Fase 01)

**Contexto.** Provedores, credenciais, sessões, permissões e aprovações cruzam
`security`, `database` e `project-engine`. Colocar essa composição no `apps/desktop`
deixaria a lógica sem testes fora do Electron.

**Decisão.** Um pacote `packages/core` (dono: Claude) compõe os serviços e expõe
`createCoreServices({ databaseFile, cipher, instanceId, ... })`. O desktop só o inicializa
(`main/core.ts`) e registra handlers. Tudo é testável com SQLite em memória ou em
diretórios temporários.

**Consequências.** O motor de execução (Codex) consome `core.*` no main. Mudanças na API
pública do Core seguem o mesmo cuidado dos contratos (registro em INTEGRATION.md).

## ADR-0014: prontidão de provedores derivada de evidências

**Status:** aceita (Fase 01)

**Decisão.** `ProviderReadiness` (`disabled` < `configured` < `available` <
`authenticated` < `operational`, ou `failing`) é **calculada**, nunca gravada. Ela vem de
três evidências (`installed`, `authenticated`, `operational`) que só
`ProviderService.recordEvidence`, uma API do main **sem canal IPC**, pode registrar, com
`source: 'execution-engine'`. Mudar executável, endpoint ou credencial zera as
evidências. Capacidades (inclusive `enforcement`) só mudam por evidência.

**Consequências.** Um provedor recém-configurado aparece como `configured`, mesmo que o
CLI esteja instalado, até o motor verificar. A UI não consegue declarar disponibilidade.

## ADR-0015: aplicação de permissões e integrações sem interceptação

**Status:** aceita (Fase 01)

**Decisão.** `AuthorizationService` é o único ponto de decisão e aplicação (`enforce`
lança erro em `deny`; `ask` cria a aprovação e espera). Para agentes cuja integração não
permite interceptar ações, `planEnforcement` exige o modo mais restritivo suportado e uma
aprovação humana por sessão, e devolve as limitações para a UI exibir. A ausência de
informação equivale a `enforcement: 'none'`.

**Consequências.** Nenhuma permissão é "decorativa": ou o DevBrain intercepta a ação, ou
o usuário aprova conscientemente rodar o agente sabendo o que não é controlado.

## ADR-0016: escopo de aprovações e grants

**Status:** aceita (Fase 01)

**Decisão.** O usuário aprova `once`, `session` ou `project`. `session` e `project` criam
um `PermissionGrant` com expiração (`security.defaultGrantTtlMs`, padrão 8 h) e alvo
opcional (glob de caminho ou executável). Grants só elevam `ask` para `allow`; não valem
para `ALWAYS_ASK_ACTIONS` nem para pedidos de origem não confiável; nunca anulam `deny`.
Grants de sessão são revogados no fim da sessão; o usuário pode revogar qualquer grant.

## ADR-0017: recuperação após falhas, sem retomada de processos

**Status:** aceita (Fase 01)

**Decisão.** Sessões pertencem à instância do app que as criou (`instance_id`). Na
inicialização, o que pertence a uma instância morta é marcado: sessões `interrupted`,
execuções `failed` com `INTERRUPTED`, aprovações `cancelled`. O DevBrain não tenta
reconectar ou "retomar" processos que já não existem. A continuação é uma **nova sessão**
consciente (`resumeFromSessionId`), que herda o último checkpoint estruturado
(`CheckpointStateV1`) e o identificador externo do provedor, se houver. Bancos
corrompidos vão para quarentena e o backup mais recente é restaurado.

## ADR-0018: crescimento limitado de histórico e logs

**Status:** aceita (Fase 01)

**Decisão.** `settings.retention` define idade máxima de eventos (30 dias) e da auditoria
(365 dias), máximo de eventos (50.000) e de bytes de saída (32 MB) por execução, tamanho e
quantidade de arquivos de log (5 MB × 5) e de backups (5). A manutenção roda na
inicialização e a cada minuto. Eventos de status, erro, aprovação e uso nunca são
descartados por limite; a saída excedente é marcada `outputTruncated`.

## ADR-0019: aplicativo desktop, terminal somente leitura e canais Git de inspeção

**Status:** aceita (Fase 01 — bloco Antigravity)

**Contexto.** A Fase 01 exige uma interface desktop completa no Windows que opere
exclusivamente sobre `window.devbrain`, exiba streaming em terminal integrado, permita
inspecionar estado e diferenças Git geradas pelo motor e preserve todas as garantias de
segurança do Electron (`contextIsolation`, `sandbox`, CSP estrita sem `unsafe-eval`, sem
acesso irrestrito ao shell pelo renderer).

**Decisão.**

1. O terminal integrado usa `@xterm/xterm` (`6.0.0`) em modo estritamente somente leitura
   (`disableStdin: true`), alimentado por `execution.event` e reconciliado com
   `executions.listEvents` por `seq` monotônico sem duplicatas. Antes da escrita no
   terminal, sequências de controle não confiáveis (`OSC` como OSC 52, `DCS`, `APC` e `CSI`
   não-SGR) são removidas no renderer (`sanitizeTerminalChunk`), e textos fora do terminal
   são renderizados apenas como nós de texto escapados (`UntrustedBlock`).
2. Para inspecionar estado e diferenças Git sem expor caminhos arbitrários ao renderer,
   `@devbrain/contracts` `0.3.0` adiciona os canais somente leitura `git.status` e
   `git.diff`, endereçados apenas por `workspaceId`, com redação de segredos e teto de
   bytes (`maxBytes`) aplicados no processo main.
3. Preferências puramente visuais (layout de painéis, estado do onboarding) ficam isoladas
   em esquema com lista branca de chaves; nenhum segredo ou caminho sensível passa por
   `localStorage`. Custos `null` vindos de provedores CLI são sempre apresentados como
   "custo desconhecido / não informado pelo provedor", nunca como zero.

## ADR-0020: custo desconhecido não é custo zero

**Status:** aceita (Fase 01, consolidação)

**Contexto.** Nenhum adaptador CLI integrado informa custo por execução: Codex informa só
tokens, e o `total_cost_usd` do Claude Code não é cobrança quando a autenticação é por
assinatura. O Antigravity informa tokens. O orçamento anterior somava apenas custos
informados, de modo que execuções sem custo contavam como zero e um teto configurado
parecia garantido sem ser.

**Decisão.**

1. Toda execução de prompt que chegou a iniciar gera uma linha em `usage_records`, com
   custo `NULL` quando o provedor não o informa. O mesmo vale para execuções de prompt
   interrompidas por queda do app. `UsageSummary.unknownCostExecutions` conta essas
   execuções, e a UI mostra "custo desconhecido" e avisa que o total é um limite inferior.
2. Com qualquer teto aplicável (diário ou mensal global, ou diário e por execução da
   política), uma execução com custo (prompt para agente) cujo `costModel` não seja
   `free` nem `local` é bloqueada com `BUDGET_UNENFORCEABLE` antes de iniciar.
3. A única exceção é o consentimento explícito `settings.budget.allowWithoutCostGuarantee`,
   rotulado na UI como "execuções SEM garantia de custo". Com ele, o teto é verificado só
   contra custos informados, e a auditoria `execution.authorized` registra
   `costGuaranteed: false`.
4. `costModel` dos adaptadores Codex e Claude Code passa a `unknown`, porque a cobrança
   depende de como o usuário se autenticou (assinatura ou chave), o que o DevBrain não
   verifica. O DevBrain nunca estima custo.
5. Comandos simples (`kind: 'command'`) executam programas locais e não passam pelo
   bloqueio de custo.

**Consequências.** Quem configura um teto e usa agentes CLI precisa remover o teto ou
consentir de forma informada. Nenhum orçamento é apresentado como garantido sem ser.

## ADR-0021: linha de comando dos agentes e inspeção Git em repositórios não confiáveis

**Status:** aceita (Fase 01, consolidação)

**Contexto.** A revisão de segurança da consolidação encontrou quatro problemas:

1. O prompt, que é texto não confiável, era passado como argumento posicional. Um prompt
   iniciado por `--` podia ser lido como flag do CLI (por exemplo
   `--dangerously-bypass-approvals-and-sandbox`).
2. O Claude Code em `-p` com `stream-json` exige `--verbose`. Com
   `--permission-mode default`, que não tem a quem perguntar, as edições eram negadas.
3. O `agy -p` sem modo explícito usa `auto`, onde disponível, segundo a documentação
   oficial de modo headless. `agy` também não documenta `--version`.
4. O `git status` e o `git diff` do próprio DevBrain liam a configuração do repositório,
   que um agente pode alterar. `core.fsmonitor` e drivers `textconv` executariam programas
   fora de qualquer sandbox do agente.

**Decisão.**

- `buildAgentCommand` (execution-engine) é a única fonte das linhas de comando e tem teste
  próprio:
  - Codex: `exec --json --sandbox <read-only|workspace-write> -C <cwd> -- <prompt>`.
  - Claude Code: `-p --output-format stream-json --verbose --permission-mode
    <plan|acceptEdits> -- <prompt>`.
  - Antigravity: `--output-format json --mode <plan|accept-edits> --print-timeout <n>s
    --print=<prompt>`.
- Modos de autoaprovação ou bypass nunca são usados.
- Esses modos não fazem o DevBrain afirmar isolamento: Codex no Windows, Claude Code e
  Antigravity continuam com `enforcement: none` e exigem aprovação por sessão.
- A presença do `agy` é verificada com `--help`, e a versão fica desconhecida.
- O sucesso do Antigravity exige `status: "SUCCESS"` no JSON. Texto livre na saída não basta.
- `LocalGitService` força `-c core.fsmonitor=false -c diff.external=` em todo comando e usa
  `--no-ext-diff --no-textconv` no diff.
- `diffBounded` lê no máximo o teto e trunca sem falhar e sem cortar UTF-8.
- O IPC lê uma margem extra, redige e só então corta, para que um segredo na fronteira
  não sobreviva parcialmente.
- `ProviderAdapter.execute` dos adaptadores CLI continua `UNSUPPORTED` e está documentado:
  o único caminho de execução é `OperationalExecutionService`.

## ADR-0022 — Gateway interno e admissões conservadoras (Fase 02)

**Contexto.** A fundação da Fase 01 tem Core, cofre e SQLite locais. Provedores
externos apresentam cotas incompletas, respostas heterogêneas e falhas parciais.

**Decisão.** O gateway é um pacote TypeScript invocado internamente pelo main do
Electron. Uma conexão de API é distinta de um agente CLI. O transporte usa HTTPS
para destinos remotos, DNS fixado para a requisição, bloqueio de endereços privados
e redirecionamentos. Endpoints de loopback exigem indicação explícita. Credenciais
são resolvidas pelo cofre existente e nunca entram no renderer. Catálogos importados
não ativam conexões. O ledger faz admissão transacional no SQLite; consumo sem
medição depois de envio é marcado incerto e conserva a reserva. A seleção
determinística ocupa um único ponto substituível pelas políticas do Claude. Em modo
gratuito, rotas pagas ou de custo desconhecido são excluídas. Após saída parcial,
não há fallback silencioso.

**Limites.** A reserva por tokens não é garantia de custo financeiro. Não se promete
cota gratuita, preço zero, compatibilidade de modelo ou autenticação por descoberta
de catálogo. O servidor HTTP local autenticado é opcional e não inicia por padrão;
seu vínculo com OpenCode, validações externas e políticas avançadas ainda exigem
implementação e evidência próprias.
