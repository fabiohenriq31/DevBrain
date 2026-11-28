# Fase 02 — relatório de consolidação (estado verificável)

Data: 2026-11-28. Branch: `phase-02/consolidation`. Base: `develop` em
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
  por meio de inferência nativa do gateway sob política do projeto. Esta
  conversa não edita arquivos nem executa comandos; a integração de ferramentas
  seguras ao agente nativo permanece pendente.
- Teste Electron isolado usa um provedor HTTP controlado para verificar cofre,
  autenticação, descoberta, credencial inválida, persistência após reinício,
  seleção do modelo no Workspace e rolagem do compositor. Não acessa dados
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
  O servidor local devolve `501` para chamadas de ferramentas, em vez de
  ignorá-las e apresentar uma execução de código fictícia.
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

## Validação e aceite

`pnpm validate`: TypeScript, lint, Prettier, 201 testes, varredura de segredos,
build e smoke Electron aprovados na consolidação. O smoke cobre a regressão
da Fase 01, armazenamento cifrado, sessões, recuperação, execução e UI.

Conexões externas autenticadas neste teste isolado: **0**. Inferências externas validadas: **0**. Modelos
locais validados neste host: **0**. Programação pelo OpenCode através do gateway:
**não demonstrada**. Fallback entre dois provedores independentes:
**não demonstrado**. Nenhuma API paga foi consumida. Assim, o cenário principal
de aceite da Fase 02 continua pendente de credenciais autorizadas e da ponte
segura com o OpenCode.

## Instalador

Versão 0.2.0, Windows x64 NSIS, sem assinatura digital. Instalador:
`E:\www\DevBrainAi-phase02-consolidation\release\DevBrain AI Setup 0.2.0.exe`
(120.754.670 bytes; SHA-256
`9D573074AC47CE110B98877C5105C252E472596EDD62CF772FBF90C50F72FB1F`).
O executável empacotado em `release/win-unpacked` também passou no smoke Electron
com perfil descartável e provedor local controlado.
Testes de instalação limpa, atualização sobre 0.1.0, desinstalação e recuperação
em perfis descartáveis ainda estão pendentes. Dados reais do usuário não foram
tocados.

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

1. Conectar OpenCode ao `LocalGatewayServer` com credencial efêmera, política
   vinculada ao projeto/sessão e isolamento efetivo de ferramentas. O CLI atual
   **não** oferece essa garantia.
2. Ampliar a leitura de cabeçalhos específicos de provedores, horário de
   renovação e custos reportados; observações só surgem quando há definição
   explícita e cabeçalho reconhecido.
3. Integrar os demais canais IPC 0.7.0 à UI, recuperação de referências de
   contexto e uso automático do handoff entre modelos,
   configuração de endpoints locais personalizados e downloads em runtimes que
   ofereçam API oficial para isso.
4. Validar dois provedores independentes e fallback real com contas autorizadas.
5. Finalizar testes de instalação e atualização em perfis descartáveis.

Esta consolidação **não representa aceite completo da Fase 02**.
