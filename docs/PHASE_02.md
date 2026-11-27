# Fase 02: AI Resource Engine

## Base compartilhada

Branch `phase-02/contracts`, derivada de `develop` após o merge da consolidação da
Fase 01 (`61ae38f`). Contratos 0.5.0 e adições 0.6.0 são aditivos; IPC permanece em `devbrain:v1`.

O catálogo é informação não confiável. A importação nunca cria conexões nem envia
credenciais. Preço e cota ausentes são desconhecidos, nunca zero. Um canal declarado sem
handler responde `UNSUPPORTED`.

## Integração

- Codex implementa gateway, transportes, catálogo, ledger, fallback, OpenCode e runtime
  local na branch `phase-02/codex-ai-gateway`.
- Claude implementa políticas de roteamento, financeira e privacidade, classificação,
  benchmarks e contexto contra estes contratos.
- Antigravity consome os canais IPC para configuração e observabilidade no renderer.

Nenhum agente deve fazer merge em `develop` ou `main`; o proprietário integra os PRs.

## Implementação Codex em andamento

O gateway nativo atende inferência interna e streaming em OpenAI Chat Completions,
Responses, Anthropic Messages, Gemini, Ollama e endpoints OpenAI-compatible. O
transporte remoto exige HTTPS, fixa o endereço resolvido, recusa endereços privados e
redirecionamentos e limita respostas. O ledger SQLite reserva cotas de forma atômica,
reconcilia consumo conhecido e retém como incerto o consumo de chamadas interrompidas.
As políticas determinísticas configuradas são recuperadas após reinício.

O snapshot Models.dev contém **327 candidatos descobertos**. Eles permanecem
desabilitados até configuração e validação próprias. Não há 20 conexões específicas
documentadas nem dois provedores reais autenticados neste ambiente. O teste de
continuidade entre duas rotas utiliza servidores controlados no teste, sem simular
validação externa. Preços e limites ausentes continuam desconhecidos.

O adaptador OpenCode CLI usa o motor operacional da Fase 01; o executável não está
instalado nesta máquina. Existe um servidor OpenAI-compatible opcional com token efêmero
em memória e bind exclusivo em `127.0.0.1`, mas seu ciclo de vida e configuração de
OpenCode ainda não estão ligados ao serviço de execução. Os canais de benchmark, seleção avançada e checkpoint pertencem ao bloco
Claude ou respondem `UNSUPPORTED` até implementação. A interface visual pertence ao
bloco Antigravity.
