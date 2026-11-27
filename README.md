# DevBrain AI

Plataforma desktop **local-first** para desenvolvimento de software com orquestração de
múltiplos agentes de IA. Ela importa e entende projetos existentes, mantém memória e
contexto compartilhados, planeja o trabalho e distribui tarefas entre agentes CLI, APIs
e modelos locais. Tudo isso acontece sob permissões, orçamento e aprovação humana.

> **Estado atual: Fase 01 consolidada (build de desenvolvimento, não assinada).** O app
> desktop para Windows já faz o seguinte:
> - importa projetos;
> - configura agentes CLI (Codex, Claude Code e Antigravity) por evidência de instalação;
> - executa agentes reais com aprovação, streaming, cancelamento, histórico, checkpoint e
>   diff Git;
> - aplica permissões e orçamento (custo desconhecido nunca vale zero);
> - recupera sessões após queda.
>
> Análise de repositórios, memória, planejamento e orquestração entre agentes são fases
> futuras. Veja [docs/PHASE_01_FINAL_REPORT.md](docs/PHASE_01_FINAL_REPORT.md) e
> [docs/PROGRESS.md](docs/PROGRESS.md).

## Requisitos

| Ferramenta | Versão |
| --- | --- |
| Windows | 10/11 x64 (plataforma inicial) |
| Node.js | ≥ 22.12 (desenvolvido com 24.x) |
| pnpm | ≥ 11 (`packageManager: pnpm@11.9.0`) |
| Git | ≥ 2.40 |

## Começando

```bash
pnpm install
pnpm build            # contracts/packages (tsc -b) + app desktop (electron-vite)
pnpm dev              # abre o app em modo desenvolvimento
pnpm validate         # typecheck + lint + format + testes + secret scan + build + smoke
pnpm --filter @devbrain/desktop dist:win   # instalador NSIS x64 (não assinado) em release/
```

O binário do Electron é baixado na primeira execução (`electron` ≥ 44). Os dados locais
ficam em `%APPDATA%\DevBrain AI\` e **nunca** dentro do repositório.

## Estrutura

```
apps/desktop              App Electron (main, preload, renderer React)
packages/contracts        Contratos versionados e validados (zod): entidades, IPC, serviços, erros
packages/security         Confinamento de caminhos, políticas, comandos, redação, cofre, limites
packages/database         SQLite local (node:sqlite), migrações, repositórios
packages/project-engine   Cadastro e gestão de projetos (entrada do DevBrain Core)
packages/core             Serviços do Core: provedores, credenciais, sessões, permissões, aprovações, recuperação
packages/provider-sdk     SDK de adaptadores (CLI, API, modelos locais)
packages/execution-engine Motor de execução de agentes (Fase 01, Codex)
packages/git-engine       Git, status e worktrees (Fase 01, Codex)
packages/ui               Tokens e componentes de UI (Antigravity)
docs/                     Plano diretor, arquitetura, contratos, segurança, decisões
tests/                    Testes de integração entre pacotes
scripts/                  Smoke test desktop, secret scan, limpeza
resources/                Ícones e recursos de empacotamento
```

## Documentação

- [Plano diretor](docs/MASTER_PLAN.md): as seis fases.
- [Arquitetura](docs/ARCHITECTURE.md).
- [Contratos](docs/CONTRACTS.md), com as regras de versionamento.
- [Segurança](docs/SECURITY.md).
- [Fase 01](docs/PHASE_01.md): blocos de Claude, Codex e Antigravity.
- [Decisões (ADRs)](docs/DECISIONS.md).
- [Progresso](docs/PROGRESS.md).
- [Relatório final da Fase 01](docs/PHASE_01_FINAL_REPORT.md).
- [Propriedade de módulos](docs/OWNERSHIP.md).
- [Integração e branches](docs/INTEGRATION.md).
- [Regras para agentes](AGENTS.md).
- [Avisos de terceiros](THIRD_PARTY_NOTICES.md).

## Licença

O projeto **ainda não tem licença definida**. Escolher uma é decisão do proprietário
(ADR-0010). Até lá, aplicam-se todos os direitos reservados.
