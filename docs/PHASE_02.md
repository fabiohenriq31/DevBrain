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
Uma conexão salva pelo IPC começa como `unknown`; a validação consulta a lista de
modelos sem gerar texto e só a marca `ready` quando o modelo configurado é encontrado.
Provedores que não expõem uma lista compatível permanecem sem validação automática.

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

## Inteligência de recursos (Claude, `phase-02/claude-intelligence`)

Pacote `@devbrain/intelligence` (políticas puras) + aplicação no gateway antes de cada
inferência e de cada fallback. Ver ADR-0023 a ADR-0026.

| Serviço | Arquivo | O que faz de verdade |
| --- | --- | --- |
| RoutingPolicyEngine | `router.ts` | Dois estágios, presets `free-only`/`local-only`/`economy`/`balanced`/`quality`/`custom`, explicação persistida |
| ModelScoringService | `scoring.ts` | Pontuação determinística; limite inferior de Wilson; confiança por tamanho de amostra |
| QuotaPolicyEngine | `quota-policy.ts` | Cotas compartilhadas, reserva por prioridade, ritmo para tarefas de baixa prioridade, previsão rotulada, cooldown por provedor |
| BudgetPolicyService | `budget.ts` | Micros inteiros, pior caso, tetos global/projeto/sessão/inferência, reserva atômica |
| PrivacyPolicyService | `privacy.ts` | Classe do projeto × fatos verificados; desconhecido = conservador |
| ContextOptimizer | `context.ts` | Dedup, compactação de log, referências com escopo, manifesto de omissões |
| ContextHandoffService | `handoff.ts` | Pacote estruturado a partir do checkpoint v1; reconciliação de efeitos colaterais |
| BenchmarkEngine | `benchmark.ts` | Suíte `devbrain-core@1.0.0` (8 casos, 7 categorias) com avaliadores objetivos |

### Economia de contexto medida

`node scripts/measure-context.mjs` (estimador conservador; mede tokens, não qualidade
da resposta):

| fixture | original | otimizado | redução | orçamento |
| --- | ---: | ---: | ---: | ---: |
| F1 build com falha (log repetido 2×) | 7295 | 696 | 90,5% | 100000 |
| F2 histórico longo (40 turnos) | 8203 | 3824 | 53,4% | 4000 |
| F3 três arquivos grandes anexados | 28053 | 591 | 97,9% | 3000 |
| F4 pequeno, sem desperdício | 53 | 53 | 0,0% | 100000 |

São fixtures sintéticas: os números variam com o conteúdo real e não são promessa de
economia.

### Benchmark

Não há runtime local (Ollama) nesta máquina e APIs pagas não foram usadas. Portanto
**não existe resultado de modelo**. Foram executados: os avaliadores com respostas
conhecidas (certas e erradas), o isolamento do avaliador de código (escrita em disco,
processo filho e laço infinito bloqueados) e um autoteste do motor com executor
roteirizado, rotulado como tal.
