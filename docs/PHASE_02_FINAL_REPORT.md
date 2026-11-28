# Fase 02 — relatório de consolidação (estado verificável)

Data: 2026-11-28. Branch: `phase-02/consolidation` (ponte de ferramentas vinda de
`phase-02/agent-bridge`). Base: `develop` em
`3cd7161`; merge de `phase-02/claude-intelligence` em `aeb403f`, que já contém
o gateway do Codex. A interface Antigravity veio de `develop`.
PR draft: https://github.com/fabiohenriq31/DevBrain/pull/9.

## Correção do onboarding real (28/11)

- O novo canal `ai.connections.discover` verifica a credencial e lista modelos
  antes de criar uma rota. OpenRouter verifica a chave em `/key`, pois `/models`
  é público. Groq, Google Gemini, OpenAI e Anthropic usam as listagens oficiais;
  Ollama e runtimes locais fazem descoberta sem enviar chaves.
- O assistente segue uma sequência de ações verificadas: credencial existente ou
  nova, conexão, autenticação e modelos, modelo salvo, rota salva, política do
  projeto. O botão de conclusão relê conexão, modelo, rota e política do Core e
  exige rota elegível na explicação do roteador. A fila antiga `11/11` só mostra
  rota salva quando a persistência real confirma; cadastros parciais podem ser
  retomados com a referência do cofre já existente.
- Preços zero/pagos e suporte a ferramentas entram apenas quando declarados nos
  metadados de OpenRouter. Groq e Gemini conservam preço e ferramentas como
  desconhecidos quando a API não os fornece. O teste de inferência ocorre após
  a rota e propaga `projectId`; só informa êxito após resultado real.
- O Workspace lista diretamente modelos com conexão pronta e rota habilitada,
  por meio de inferência nativa do gateway sob política do projeto. O painel
  direto de conversa não edita arquivos; o runtime separado do DevBrain Agent
  usa ferramentas submetidas ao Core e foi validado com provedor controlado.
- Teste Electron isolado usa um provedor HTTP controlado e percorre o
  assistente pela interface: reutiliza a chave cifrada, autentica, descobre
  modelos gratuitos e pagos, escolhe um modelo com ferramentas, salva rota e
  política e confirma a persistência. Também cobre credencial inválida,
  retomada após reinício, seleção no Workspace e rolagem. Não acessa dados
  reais nem APIs pagas.

## Entregas integradas

- Gateway interno com transporte HTTP protegido contra SSRF, DNS rebinding e
  redirecionamentos; protocolos Chat Completions, Responses, Anthropic Messages,
  Gemini e Ollama; streaming, cancelamento e fallback.
- Ledger SQLite com reservas atômicas, recuperação conservadora após interrupção,
  políticas financeiras e roteamento explicável. A migration 005 guarda
  observações reais de `x-ratelimit-remaining-requests` e
  `x-ratelimit-remaining-tokens` quando há uma definição de cota correspondente.
  A interface usa o Core para
  credenciais criptografadas, sessões e projetos.
- 327 candidatos do snapshot Models.dev, separados de conexões ativas. O catálogo
  instalado inclui 22 receitas de conexão documentadas. A ausência de preço ou
  cota permanece `unknown`; nenhuma receita cria credenciais ou ativa rotas.
- A classificação de privacidade exibida pela interface é lida e gravada por
  `ai.projectPolicy.*` no processo main e não é gravada em `localStorage`.
  Diagnósticos e seleção de rotas enviam o projeto ativo; a interface bloqueia
  o diagnóstico sem projeto. O processo main valida `projectId` e sua
  correspondência com a sessão em inferência e inspeção de rotas. A interface
  consulta `ai.routes.explain`, `ai.budget.status`, `ai.quota.forecast` e
  `ai.cost.get` para mostrar motivos de exclusão, orçamento reservado,
  projeções de cota e custo da última inferência quando esses dados existem.
  Fatos de privacidade são lidos de `ai.privacyProfiles.list` e só são salvos
  por ação do usuário com URL de fonte e confirmação explícita; fatos não
  informados continuam `unknown`.
- Execuções CLI incompatíveis com projeto restrito são bloqueadas no motor. O
  OpenCode CLI sem ponte verificada ao gateway só pode operar em projeto público
  com autorização explícita para custo pago e ilimitado. Esse modo usa a conta
  própria do CLI e **não** recebe as garantias de cotas do gateway.
  O servidor local transporta chamadas de ferramentas desde os contratos 0.8.0,
  sem executá-las (ver seção da ponte de ferramentas).
- Benchmarks que executariam JavaScript gerado pelo modelo foram desativados:
  o permission model de Node não isola rede. A suíte exposta contém apenas
  avaliações estáticas/estruturadas. A interface agora consulta as suítes e
  evidências reais do processo main e permite executar uma suíte em projeto
  existente, rota selecionada e com confirmação explícita de consumo. O
  gateway aplica as políticas de privacidade, orçamento e cota do projeto.
- O fluxo de inferência aplica deduplicação determinística de histórico antes
  do roteamento e do envio ao provedor. Compactação com omissão e referências
  segue desabilitada até existir recuperação durável dos trechos removidos.
- O handoff consultado na interface inclui a branch Git observada no workspace,
  arquivos registrados pelos eventos da sessão e comandos de teste explícitos
  com seu estado. O commit base só é afirmado quando há checkpoint.
- Descoberta local por `GET /v1/models` para LM Studio e llama.cpp server,
  além da API nativa do Ollama. Identificadores upstream com `/` são aceitos
  pelos contratos 0.7.1. A porta padrão documentada do llama.cpp é 9931.
  A medição manual de modelos instalados no Ollama usa `POST /api/generate`
  e os contadores reais `eval_count`/`eval_duration`; TTFT permanece
  desconhecido porque a medição não transmite tokens em streaming. O resultado
  local aparece na sessão da interface, sem persistência entre reinícios.

## Perfis específicos documentados

| Provedor | Endpoint/protocolo | Estado |
| --- | --- | --- |
| OpenAI | API oficial / Chat Completions | Receita, sem autenticação testada |
| Anthropic | API oficial / Messages | Receita, sem autenticação testada |
| Google Gemini | API oficial / Gemini | Receita, sem autenticação testada |
| Groq | API oficial / Chat Completions | Receita, sem autenticação testada |
| OpenRouter | API oficial / Chat Completions | Receita, sem autenticação testada |
| Mistral | API oficial / Chat Completions | Receita, sem autenticação testada |
| NVIDIA NIM | API oficial / Chat Completions | Receita, sem autenticação testada |
| Cohere | API Compatibility / Chat Completions | Receita, sem autenticação testada |
| Cerebras | API oficial / Chat Completions | Receita, sem autenticação testada |
| DeepSeek | API oficial / Chat Completions | Receita, sem autenticação testada |
| Hugging Face | Inference Providers / Chat Completions | Receita, sem autenticação testada |
| Vercel AI Gateway | API oficial / Chat Completions | Receita, sem autenticação testada |
| Together AI | API oficial / Chat Completions | Receita, sem autenticação testada |
| Fireworks AI | API oficial / Chat Completions | Receita, sem autenticação testada |
| DeepInfra | API oficial / Chat Completions | Receita, sem autenticação testada |
| SiliconFlow | API China / Chat Completions | Receita, sem autenticação testada |
| Alibaba Model Studio | API Beijing / Chat Completions | Receita, requer conta regional |
| Z.ai | API oficial / Chat Completions | Receita, sem autenticação testada |
| Cloudflare Workers AI | Endpoint por conta / Chat Completions | Configuração manual obrigatória |
| Ollama | Loopback / API nativa | Receita, runtime não encontrado neste teste |
| LM Studio | Loopback / Chat Completions | Receita, runtime não encontrado neste teste |
| llama.cpp server | Loopback / Chat Completions | Receita, runtime não encontrado neste teste |

Fontes oficiais por perfil estão em `packages/ai-gateway/src/profiles.ts`. Os
metadados das receitas são originais do DevBrain; não há código copiado.
Ofertas, preços, limites, restrições regionais e privacidade permanecem
desconhecidos até verificação explícita por conta e modelo.

## Ponte de ferramentas e agente nativo

- Contratos 0.8.0 com definições, chamadas, resultados, erros, chamadas paralelas, estados
  de execução e fragmentos de argumentos em streaming correlacionados por índice e id.
- Protocolos com ferramentas: Chat Completions (e `custom`), Anthropic Messages, Gemini e
  Ollama, em requisição, histórico, resposta e streaming. O Responses API recusa ferramentas
  com `UNSUPPORTED`. O roteador só admite modelos cadastrados com capacidade de ferramentas.
- O servidor local traduz `tools`, `tool_choice`, `parallel_tool_calls`, mensagens `tool` e
  `tool_calls`. Ele não executa ferramentas. `functions` legado continua `501`.
- Agente nativo `devbrain-agent` (ADR-0029): listar, ler, buscar, editar por trecho único,
  criar arquivo, `git status`/`git diff` e comandos pré-autorizados por id, sem shell. Cada
  ação passa por `enforce`/`authorizeCommand`, com aprovações. Limites de turnos, chamadas,
  tokens e duração. Repetição sem progresso encerra a execução. Efeito colateral de
  resultado desconhecido não é repetido antes de verificação. A troca de modelo só ocorre
  entre turnos, e o checkpoint leva o registro para a execução seguinte.
- OpenCode: **não integrado como agente operacional**. A configuração do repositório pode
  sobrepor provedores, plugins e MCP, e suas ferramentas rodam fora do Core. O bloqueio
  existente foi mantido e não há afirmação de modo gratuito, local ou restrito para ele.

## Validação e aceite

`pnpm validate`: TypeScript, lint, Prettier, 218 testes, varredura de segredos,
build e smoke Electron aprovados após a integração. `verify:scroll` aprovou
34 verificações de rolagem real no Electron.

**Validado em ambiente controlado** (`packages/execution-engine/src/agent.e2e.test.ts`,
com Core e AiGateway reais e um servidor OpenAI-compatível roteirizado em loopback, num
repositório Git temporário):

- o modelo lista e lê o código, executa o teste autorizado (falha), edita `src/sum.js`,
  executa de novo (passa), consulta o diff e termina; evidências em eventos, uso e checkpoint;
- `.env` negado pela política sem chegar ao modelo; fuga do workspace pedida e recusada;
  comando fora da lista inválido; `write_file` sobre arquivo existente recusado;
- fallback entre duas rotas controladas, com a troca registrada no limite do turno e o
  histórico estruturado entregue inteiro à segunda rota;
- estratégia gratuita ignora a rota paga sem chamá-la; projeto restrito não alcança rota
  não local;
- cancelamento durante um comando marca o resultado como desconhecido, e a execução seguinte
  recebe a verificação pendente;
- chamada repetida e limite de turnos encerram a execução.

Testes de protocolo cobrem serialização e parsing por protocolo, com e sem streaming, e a
ponte HTTP de ferramentas.

O smoke de recuperação após queda aguarda a gravação inicial do `Local State`
do Electron antes de encerrar o processo à força. Uma queda imediata no
primeiro arranque, antes de o Electron persistir sua chave do `safeStorage`,
pode tornar a credencial recém-gravada indecifrável; nesse caso o gateway
retorna `CREDENTIAL_UNAVAILABLE` e solicita substituição no cofre. Essa
limitação foi observada apenas no perfil descartável do teste.

**Com modelos reais: nada validado neste perfil descartável.** Conexões externas
autenticadas no teste: **0**. Inferências externas: **0**. Modelos locais neste host:
**0** (sem Ollama, LM Studio ou llama.cpp). Nenhuma API
paga foi consumida e nenhuma chave foi pedida.

### Aceite com modelo real pelo proprietário

Nunca envie chaves pelo chat nem pelo GitHub. A chave é digitada só no DevBrain e fica no
cofre cifrado do sistema.

1. Use uma cópia descartável de um projeto Git, nunca o projeto real.
2. Central de IA: crie a conexão (perfil documentado ou modelo local), cadastre o modelo com
   **ferramentas** habilitado somente se a documentação do provedor confirmar tool calling
   para ele, e crie a rota. Para Ollama, use um modelo que a biblioteca do Ollama marque com
   suporte a ferramentas.
3. Configure uma estratégia "somente gratuito" ou "somente local" e a política do projeto.
4. Para conversar, selecione o modelo diretamente no Workspace. Para executar uma
   tarefa de programação, crie uma vez o agente nativo "DevBrain Agent (AI Gateway)"
   no catálogo de adapters; não crie um provedor CLI por modelo.
5. No Workspace, selecione o agente nativo, o modelo e a estratégia; mantenha o
   comando `test: node --test` (ou o comando de teste do projeto, sem shell).
6. Peça uma correção pequena com teste. Aprove a execução do comando quando solicitado.
7. Confira os eventos (estado de cada chamada), o diff, o uso e o checkpoint. Para fallback,
   cadastre duas rotas e desabilite a primeira durante a execução.

Critério de aceite: tarefa concluída, teste passando, diff restrito aos arquivos esperados e
nenhuma chamada fora das rotas da estratégia em `ai.usage.list`.

## Instalador

Versão 0.2.0, Windows x64 NSIS, sem assinatura digital, reconstruído na
consolidação: `E:\www\DevBrainAi-phase02-consolidation\release\DevBrain AI Setup 0.2.0.exe`
(120.765.751 bytes; SHA-256
`9FDD721A034838A8D1F9EC19EC444B1641D80A1146B51DC4A64BB366B6D779F9`).
O executável empacotado passou no smoke Electron em perfil descartável.

Validado com diretório de instalação e `--user-data-dir` descartáveis: instalação silenciosa
da 0.1.0, execução, atualização no mesmo diretório para 0.2.0 com os mesmos dados
(migrations 1–2 da 0.1.0 preservadas, 3–5 aplicadas pela 0.2.0), smoke completo sobre o
binário instalado e desinstalação silenciosa (executável, entrada no registro e atalhos
removidos; dados do usuário mantidos, como configurado). Dados reais do usuário não foram
tocados. Não testado: instalação interativa, máquina limpa sem dependências e assinatura.

## Primeira utilização

1. Abra o DevBrain e importe um projeto Git de teste.
2. Na Central de IA, escolha um perfil e confira a documentação e o endpoint.
3. Reutilize a chave já guardada no cofre ou cadastre uma nova pelo assistente;
   registre a conexão e valide a autenticação pela descoberta oficial.
4. Escolha um modelo descoberto, salve a rota e configure privacidade e orçamento
   do projeto. O assistente só conclui quando a rota é elegível.
5. Autorize o teste de inferência quando quiser confirmar a operação real e
   confira o modelo disponível no Workspace.

## Pendências objetivas para continuação

1. Aceite com pelo menos um modelo real com ferramentas (nuvem gratuita ou local), seguindo
   o procedimento acima, e fallback entre dois provedores independentes.
2. OpenCode só poderá ser declarado integrado quando houver configuração que o repositório
   não sobreponha e execução de ferramentas sob o Core, ou isolamento de SO verificado.
3. Ampliar cabeçalhos de cota por provedor, horário de renovação e custos reportados.
4. Demais canais IPC 0.7.0 na UI, recuperação de referências de contexto e handoff
   automático entre modelos.
5. Instalador assinado e teste em máquina limpa.

O núcleo funcional da Fase 02 está implementado e validado em ambiente controlado; o aceite
com modelos reais depende de credenciais ou runtimes locais do proprietário.
