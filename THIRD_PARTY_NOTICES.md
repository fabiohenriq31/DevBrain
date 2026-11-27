# Avisos de terceiros

## Código e assets incorporados

**Nenhum** código-fonte ou asset de terceiros foi copiado para este repositório até a
Etapa 00. Quando houver, registre aqui o projeto, a licença, o aviso de copyright e os
arquivos derivados.

### Referência: Habblaud

- Repositório: https://github.com/marmottajr/habblaud
- Licença declarada: **MIT**, "Copyright (c) 2026 Márcio Junior" (arquivo `LICENSE` e
  `package.json`, verificados em 2026-11-27).
- Uso atual: **apenas referência visual e funcional**, sem cópia.
- Condições para reaproveitar código (ADR-0011):
  - manter o texto da licença MIT e o aviso de copyright nesta seção e no cabeçalho dos
    arquivos derivados;
  - **não** copiar as imagens de `client/public/assets`, que o README declara geradas
    com IA (titularidade incerta);
  - não depender de formatos internos e não documentados de ferramentas de terceiros
    que o Habblaud lê;
  - não usar marcas ou assets de jogos de terceiros.

## Dependências npm diretas

Todas são instaladas via npm, com versões fixadas em `pnpm-lock.yaml`. Licenças conforme
os metadados publicados de cada pacote.

| Pacote | Versão | Licença |
| --- | --- | --- |
| electron | 44.11.1 | MIT |
| electron-vite | 6.0.0 | MIT |
| vite | 8.3.8 | MIT |
| @vitejs/plugin-react | 6.3.0 | MIT |
| react, react-dom | 19.1.10 | MIT |
| zod | 4.6.7 | MIT |
| typescript | 6.0.3 | Apache-2.0 |
| vitest | 5.1.0 | MIT |
| eslint | 10.14.0 | MIT |
| @eslint/js | 10.0.1 | MIT |
| typescript-eslint | 8.72.2 | MIT |
| globals | 17.14.0 | MIT |
| prettier | 3.10.0 | MIT |
| @types/node, @types/react, @types/react-dom | 26.6.6 / 19.3.0 / 19.3.0 | MIT |

O Electron distribui o Chromium e o Node.js, cada um com as próprias licenças
(`LICENSES.chromium.html` no binário). Ao empacotar o instalador, a Fase 01 deve incluir
esses avisos.
