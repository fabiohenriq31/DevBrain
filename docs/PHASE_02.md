# Fase 02: AI Resource Engine

## Base compartilhada

Branch `phase-02/contracts`, derivada de `develop` após o merge da consolidação da
Fase 01 (`61ae38f`). Contratos 0.5.0 são aditivos; IPC permanece em `devbrain:v1`.

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
