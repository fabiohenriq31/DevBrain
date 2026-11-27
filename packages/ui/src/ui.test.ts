import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  SplitPane,
  Tabs,
  UntrustedBlock,
  resolveEffectiveTheme,
  type FieldProps,
} from './index.js';

type RowItem = { id: string; name: string };

describe('@devbrain/ui primitives and layout', () => {
  it('resolves effective theme from user preference and OS setting', () => {
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });

  it('renders accessible Button, Badge and Field with error alert linkage', () => {
    const fieldProps: FieldProps = {
      label: 'Diretório',
      error: 'Caminho inválido',
      required: true,
      children: (props) => createElement(Input, { ...props, defaultValue: 'relative/path' }),
    };
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Button, { variant: 'primary', loading: true }, 'Executar'),
        createElement(Badge, { tone: 'warning', dot: true }, 'Aguardando aprovação'),
        createElement(Field, fieldProps),
      ),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Aguardando aprovação');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Caminho inválido');
  });

  it('escapes untrusted agent/tool payloads and never injects raw HTML', () => {
    const malicious = '<img src=x onerror="alert(1)"><script>window.pwned=1</script>';
    const html = renderToStaticMarkup(
      createElement(UntrustedBlock, { text: malicious, label: 'stdout' }),
    );
    expect(html).toContain('data-untrusted="true"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders accessible Dialog, Tabs, DataTable and SplitPane', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(
          Dialog,
          { open: true, title: 'Solicitação de aprovação', onClose: () => undefined },
          'Revisar ação',
        ),
        createElement(Tabs, {
          tabs: [
            { id: 'terminal', label: 'Terminal', badge: 3 },
            { id: 'diff', label: 'Diff Git' },
          ],
          active: 'terminal',
          onChange: () => undefined,
        }),
        createElement(DataTable<RowItem>, {
          columns: [{ key: 'name', header: 'Projeto', render: (r: RowItem) => r.name }],
          rows: [{ id: '1', name: 'DevBrain' }],
          rowKey: (r: RowItem) => r.id,
          selectedKey: '1',
          onSelectRow: () => undefined,
        }),
        createElement(SplitPane, {
          direction: 'horizontal',
          initialSize: 280,
          minSize: 200,
          maxSize: 480,
          first: createElement('div', null, 'Esquerda'),
          second: createElement('div', null, 'Direita'),
        }),
        createElement(Banner, { tone: 'danger', title: 'Permissão negada' }, 'Escopo bloqueado'),
        createElement(EmptyState, {
          title: 'Sem sessões',
          description: 'Inicie uma sessão para enviar instruções.',
        }),
      ),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('Permissão negada');
  });
});
