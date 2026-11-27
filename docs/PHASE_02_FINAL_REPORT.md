# Fase 02 — relatório de consolidação (estado verificável)

Data: 2026-11-27. Branch: `phase-02/consolidation`. Base: `develop` em
`3cd7161`; merge de `phase-02/claude-intelligence` em `aeb403f`, que já contém
o gateway do Codex. A interface Antigravity veio de `develop`.
PR draft: https://github.com/fabiohenriq31/DevBrain/pull/9.

## Entregas integradas

- Gateway interno com transporte HTTP protegido contra SSRF, DNS rebinding e
  redirecionamentos; protocolos Chat Completions, Responses, Anthropic Messages,
  Gemini e Ollama; streaming, cancelamento e fallback.
- Ledger SQLite com reservas atômicas, recuperação conservadora após interrupção,
  políticas financeiras e roteamento explicável. A interface usa o Core para
  credenciais criptografadas, sessões e projetos.
- 327 candidatos do snapshot Models.dev, separados de conexões ativas. O catálogo
  instalado inclui 22 receitas de conexão documentadas. A ausência de preço ou
  cota permanece `unknown`; nenhuma receita cria credenciais ou ativa rotas.
- A classificação de privacidade exibida pela interface é lida e gravada por
  `ai.projectPolicy.*` no processo main. Inferências de sessão exigem `projectId`
  válido e correspondente ao projeto da sessão.
- Execuções CLI incompatíveis com projeto restrito são bloqueadas no motor. O
  OpenCode CLI sem ponte verificada ao gateway só pode operar em projeto público
  com autorização explícita para custo pago e ilimitado. Esse modo usa a conta
  própria do CLI e **não** recebe as garantias de cotas do gateway.
- Benchmarks que executariam JavaScript gerado pelo modelo foram desativados:
  o permission model de Node não isola rede. A suíte exposta contém apenas
  avaliações estáticas/estruturadas.

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

`pnpm validate`: TypeScript, lint, Prettier, 194 testes, varredura de segredos,
build e smoke Electron aprovados na consolidação. O smoke cobre a regressão
da Fase 01, armazenamento cifrado, sessões, recuperação, execução e UI.

Conexões autenticadas: **0**. Inferências externas validadas: **0**. Modelos
locais validados neste host: **0**. Programação pelo OpenCode através do gateway:
**não demonstrada**. Fallback entre dois provedores independentes:
**não demonstrado**. Nenhuma API paga foi consumida. Assim, o cenário principal
de aceite da Fase 02 continua pendente de credenciais autorizadas e da ponte
segura com o OpenCode.

## Instalador

Versão 0.2.0, Windows x64 NSIS, sem assinatura digital. Instalador:
`E:\www\DevBrainAi-phase02-consolidation\release\DevBrain AI Setup 0.2.0.exe`
(120.746.638 bytes; SHA-256
`42A143D36255B4DC0FDF6B8D13F28558406F124086D4C0745101D0884DB2C8BC`).
Testes de instalação limpa, atualização sobre 0.1.0, desinstalação e recuperação
em perfis descartáveis ainda estão pendentes. Dados reais do usuário não foram
tocados.

## Primeira utilização

1. Abra o DevBrain e importe um projeto Git de teste.
2. Na Central de IA, escolha um perfil e confira a documentação e o endpoint.
3. Guarde a chave no cofre pelo assistente, cadastre um modelo e configure sua rota.
4. Valide a conexão e configure a política de privacidade e orçamento do projeto.
5. Execute inferência apenas após confirmar oferta, preço e cotas da conta.

## Pendências objetivas para continuação

1. Conectar OpenCode ao `LocalGatewayServer` com credencial efêmera, política
   vinculada ao projeto/sessão e isolamento efetivo de ferramentas. O CLI atual
   **não** oferece essa garantia.
2. Persistir observações reais de cabeçalhos de cota e custos reportados pelos
   provedores; `ai.quota.observations` ainda retorna lista vazia.
3. Integrar os demais canais IPC 0.7.0 à UI, contexto e handoff ao fluxo real,
   descoberta de modelos e os runtimes locais adicionais.
4. Validar dois provedores independentes e fallback real com contas autorizadas.
5. Finalizar testes de instalação e atualização em perfis descartáveis.

Esta consolidação **não representa aceite completo da Fase 02**.
