# Motor operacional (Fase 01)

O serviço `OperationalExecutionService` usa a autorização, o limite de concorrência, as
sessões e a persistência de `@devbrain/core`. Ele não cria banco ou política própria.
O chamador cria uma sessão pelo Core e injeta o mesmo `CoreServices` no motor.
`submit` retorna um identificador imediatamente; `subscribe` transmite eventos e
`wait` aguarda o resultado. `interrupt` cancela a fila ou encerra a árvore do processo.

CLI conhecidos:

- Codex: `codex exec --json --sandbox <read-only|workspace-write> -C <cwd> <prompt>`.
  Conclusão exige `turn.completed` no JSONL e exit code zero.
- Claude Code: `claude -p <prompt> --output-format stream-json --permission-mode default`.
  Conclusão exige o registro `result` com `is_error: false` e exit code zero.
- Antigravity CLI: `agy --print <prompt>`. A saída simples precisa ser não vazia e
  o processo terminar com exit code zero.

As três integrações requerem executável nativo que aceite `spawn` sem shell. Um shim
`.cmd` sozinho, comum em instalações npm no Windows, é reportado como dependência
indisponível. Não há passagem pelo shell para executá-lo. O motor não usa flags para
desativar aprovação ou sandbox. Codex no Windows é tratado conservadoramente como
`enforcement: none`, pois o diretório de trabalho não é um isolamento do sistema
operacional. O Core exige aprovação humana por sessão nessa condição. A execução
não promete bloquear cada ação interna do agente ou acesso a arquivos fora do workspace
no Windows. Use a política `read-only` quando isso for incompatível com o risco.

Os eventos de saída são redigidos antes de ir ao Core. O Core aplica retenção e
persistência; a UI deve recuperar lacunas com `executions.listEvents` e `afterSeq`.
Uma execução concluída grava um checkpoint operacional com o commit Git e os arquivos
observados. Mudanças anteriores do usuário não são descartadas.

Referências oficiais:

- https://developers.openai.com/blog/codex-as-a-platform
- https://code.claude.com/docs/en/cli-reference
- https://codelabs.developers.google.com/sdd-agy-cli
