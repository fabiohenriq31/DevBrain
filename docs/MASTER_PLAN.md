# Plano diretor

O DevBrain AI evolui em seis fases. Cada fase entrega valor utilizável e **não reescreve**
os fundamentos: contratos versionados, monólito modular, persistência local e fronteira de
segurança única. As fases futuras acrescentam pacotes; não substituem os que já existem.

## Princípios permanentes

1. **Local-first.** As funcionalidades essenciais funcionam sem infraestrutura própria na
   nuvem. Serviços externos são provedores opcionais.
2. **Humano no controle.** Ações destrutivas, externas, com privilégio ou fora do escopo
   exigem aprovação.
3. **Contratos antes de implementação.** O trabalho paralelo de três agentes depende disso.
4. **Honestidade operacional.** Nada simulado é apresentado como pronto.
5. **Evolução incremental.** Cada fase deixa o produto instalável e estável.

## Fase 0 (Etapa 00): fundação arquitetural ✅

Monorepo, contratos, segurança base, persistência, cadastro de projetos, shell Electron
seguro, documentação, ownership e branches.

## Fase 1: fundação operacional

**Objetivo:** abrir projetos reais e executar um agente CLI real com segurança.

- App desktop navegável: projetos, sessões, terminal de saída e aprovações (Antigravity).
- Motor de execução: spawn sem shell, streaming, interrupção, timeouts, limites e
  persistência de eventos (Codex).
- Adaptadores dos primeiros agentes CLI, implementados a partir da documentação oficial
  (Codex).
- Git engine: detecção, status, worktrees (Codex).
- Serviço de aprovações, cofre de credenciais com `safeStorage`, políticas por agente,
  checkpoints básicos (Claude).
- Empacotamento Windows instalável (Codex/Antigravity).

Detalhamento em [PHASE_01.md](PHASE_01.md).

## Fase 2: DevBrain Core

**Objetivo:** compreender projetos.

- Análise de repositórios: linguagens, manifestos, dependências, pontos de entrada.
- Árvore hierárquica de processos e funcionalidades, com o React Flow como visualização.
- Mapa de arquitetura (módulos, dependências, camadas).
- Memória compartilhada: fatos, decisões e contexto por projeto, versionados e com origem
  rastreável, numa base de conhecimento local em SQLite (com FTS e, opcionalmente,
  embeddings locais).
- Planejamento: decomposição de objetivos em tarefas com dependências.

## Fase 3: orquestração multiagentes

- Equipes dinâmicas, com papéis e competências.
- Scheduler com prioridade, dependências, custo, disponibilidade e limites de concorrência.
- Delegação e execução paralela isolada em Git worktrees.
- Integração de código: merge, conflitos, revisão cruzada e testes como portão.
- Kanban e grafo de tarefas.

## Fase 4: ecossistema de IAs

- Provedores HTTP gratuitos e pagos, modelos locais (Ollama e interfaces compatíveis), MCP.
- Roteamento por capacidade, custo e qualidade.
- Cotas, orçamento, contabilidade de consumo.
- Failover: transferir a tarefa para outro provedor a partir do último checkpoint.

## Fase 5: empresa virtual

- Escritório interativo em PixiJS, inspirado no Habblaud (ver
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).
- Agentes como personagens; departamentos, salas, reuniões, comunicação.
- Painéis operacionais e dashboards.

## Fase 6: consolidação

- Segurança avançada: isolamento de processos por utility process ou AppContainer,
  assinatura de código, auditoria exportável.
- Desempenho, recuperação de falhas, atualizações automáticas, distribuição.
- DevBrain participando do próprio desenvolvimento.

## Pontos de extensão já previstos

| Fase futura | Onde se encaixa |
| --- | --- |
| Análise, árvore, memória | Novos pacotes `packages/repo-analyzer`, `packages/knowledge`, `packages/planner` + migrações + canais IPC |
| Scheduler e equipes | `packages/orchestrator` consumindo `ExecutionService` e `ConcurrencyLimiter` |
| Provedores | Novos `ProviderAdapter` no `ProviderRegistry` (`kind: http-api / local-model`) |
| Failover | `Checkpoint` + `ExecutionRequest.idempotencyKey` + `ProviderStatus` |
| Escritório virtual | `packages/office` (PixiJS) consumindo eventos `IPC_EVENTS` |
