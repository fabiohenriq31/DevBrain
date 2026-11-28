import {
  createElement as h,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { tokens } from './tokens.js';

export interface DialogProps {
  open: boolean;
  title: string;
  subtitle?: string | undefined;
  width?: number | undefined;
  onClose: () => void;
  dismissible?: boolean | undefined;
  footer?: ReactNode | undefined;
  children?: ReactNode;
}

export const Dialog = ({
  open,
  title,
  subtitle,
  width = 560,
  onClose,
  dismissible = true,
  footer,
  children,
}: DialogProps): ReactElement | null => {
  const titleId = useId();
  useEffect(() => {
    if (!open || !dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return h(
    'div',
    {
      role: 'presentation',
      onMouseDown: (e: ReactMouseEvent<HTMLDivElement>) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      },
      style: {
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--db-backdrop, rgba(4, 7, 12, 0.72))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        overflow: 'hidden',
      },
    },
    h(
      'div',
      {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': titleId,
        style: {
          width: '100%',
          maxWidth: `min(${width}px, calc(100vw - 32px))`,
          maxHeight: 'calc(100vh - 32px)',
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.borderStrong}`,
          borderRadius: tokens.radius.lg,
          boxShadow: '0 20px 48px rgba(0, 0, 0, 0.45)',
          overflow: 'hidden',
        },
      },
      h(
        'div',
        {
          style: {
            padding: '12px 16px',
            borderBottom: `1px solid ${tokens.color.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexShrink: 0,
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'h2',
            {
              id: titleId,
              style: { margin: 0, fontSize: 14, fontWeight: 600, color: tokens.color.text },
            },
            title,
          ),
          subtitle
            ? h(
                'div',
                { style: { fontSize: 11.5, color: tokens.color.textMuted, marginTop: 2 } },
                subtitle,
              )
            : null,
        ),
        dismissible
          ? h(
              'button',
              {
                type: 'button',
                'aria-label': 'Fechar',
                onClick: onClose,
                style: {
                  background: 'transparent',
                  border: 'none',
                  color: tokens.color.textMuted,
                  cursor: 'pointer',
                  fontSize: 16,
                  lineHeight: 1,
                  padding: '4px 6px',
                  borderRadius: tokens.radius.sm,
                  flexShrink: 0,
                },
              },
              '×',
            )
          : null,
      ),
      h(
        'div',
        {
          'data-scroll-region': 'dialog-body',
          style: {
            padding: 16,
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'auto',
          },
        },
        children,
      ),
      footer
        ? h(
            'div',
            {
              style: {
                padding: '10px 16px',
                borderTop: `1px solid ${tokens.color.border}`,
                background: tokens.color.surfaceElevated,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                flexWrap: 'wrap',
                gap: 8,
                flexShrink: 0,
              },
            },
            footer,
          )
        : null,
    ),
  );
};

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  badge?: number | string | undefined;
}

export interface TabsProps<T extends string = string> {
  tabs: readonly TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel?: string | undefined;
  rightSlot?: ReactNode | undefined;
}

export const Tabs = <T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  rightSlot,
}: TabsProps<T>): ReactElement => {
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const idx = tabs.findIndex((t) => t.id === active);
    if (idx < 0) return;
    e.preventDefault();
    const nextIdx =
      e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
    const next = tabs[nextIdx];
    if (next) onChange(next.id);
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth > el.clientWidth && e.deltaX === 0 && e.deltaY !== 0) {
      el.scrollLeft += e.deltaY;
    }
  };
  return h(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${tokens.color.border}`,
        padding: '0 12px',
        gap: 8,
        minHeight: 34,
        minWidth: 0,
        flexShrink: 0,
        background: tokens.color.surface,
      },
    },
    h(
      'div',
      {
        role: 'tablist',
        'aria-label': ariaLabel,
        onKeyDown,
        onWheel,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flex: '1 1 auto',
          minWidth: 0,
          overflowX: 'auto',
          overflowY: 'hidden',
        },
      },
      tabs.map((tab) => {
        const isSelected = tab.id === active;
        return h(
          'button',
          {
            key: tab.id,
            role: 'tab',
            type: 'button',
            'aria-selected': isSelected,
            tabIndex: isSelected ? 0 : -1,
            onClick: () => onChange(tab.id),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 33,
              padding: '0 10px',
              background: 'transparent',
              border: 'none',
              borderBottom: isSelected
                ? `2px solid ${tokens.color.accent}`
                : '2px solid transparent',
              color: isSelected ? tokens.color.text : tokens.color.textMuted,
              fontWeight: isSelected ? 600 : 500,
              fontSize: 12,
              fontFamily: tokens.font.sans,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            },
          },
          h('span', null, tab.label),
          tab.badge !== undefined
            ? h(
                'span',
                {
                  style: {
                    fontSize: 10.5,
                    padding: '1px 5px',
                    borderRadius: tokens.radius.sm,
                    background: isSelected
                      ? tokens.color.accentSubtle
                      : tokens.color.surfaceElevated,
                    color: isSelected ? tokens.color.accent : tokens.color.textFaint,
                    fontFamily: tokens.font.mono,
                  },
                },
                tab.badge,
              )
            : null,
        );
      }),
    ),
    rightSlot
      ? h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
          rightSlot,
        )
      : null,
  );
};

export interface TableColumn<Row> {
  key: string;
  header: string;
  width?: string | number | undefined;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  selectedKey?: string | null | undefined;
  onSelectRow?: ((row: Row) => void) | undefined;
  emptyMessage?: string | undefined;
}

export const DataTable = <Row>({
  columns,
  rows,
  rowKey,
  selectedKey,
  onSelectRow,
  emptyMessage = 'Nenhum registro disponível.',
}: DataTableProps<Row>): ReactElement =>
  h(
    'div',
    {
      'data-scroll-region': 'data-table',
      style: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 0,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        overflowX: 'auto',
        overflowY: 'auto',
        background: tokens.color.surface,
      },
    },
    h(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' } },
      h(
        'thead',
        null,
        h(
          'tr',
          { style: { background: tokens.color.surfaceElevated } },
          columns.map((col) =>
            h(
              'th',
              {
                key: col.key,
                style: {
                  padding: '7px 10px',
                  fontWeight: 600,
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  borderBottom: `1px solid ${tokens.color.border}`,
                  width: col.width,
                  whiteSpace: 'nowrap',
                },
              },
              col.header,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        rows.length === 0
          ? h(
              'tr',
              null,
              h(
                'td',
                {
                  colSpan: columns.length,
                  style: {
                    padding: '18px 12px',
                    textAlign: 'center',
                    color: tokens.color.textMuted,
                  },
                },
                emptyMessage,
              ),
            )
          : rows.map((row) => {
              const key = rowKey(row);
              const selected = selectedKey === key;
              return h(
                'tr',
                {
                  key,
                  tabIndex: onSelectRow ? 0 : undefined,
                  'aria-selected': onSelectRow ? selected : undefined,
                  onClick: onSelectRow ? () => onSelectRow(row) : undefined,
                  onKeyDown: onSelectRow
                    ? (e: ReactKeyboardEvent<HTMLTableRowElement>) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onSelectRow(row);
                        }
                      }
                    : undefined,
                  style: {
                    borderBottom: `1px solid ${tokens.color.border}`,
                    background: selected ? tokens.color.accentSubtle : 'transparent',
                    cursor: onSelectRow ? 'pointer' : 'default',
                  },
                },
                columns.map((col) =>
                  h(
                    'td',
                    {
                      key: col.key,
                      style: {
                        padding: '7px 10px',
                        color: tokens.color.text,
                        verticalAlign: 'middle',
                      },
                    },
                    col.render(row),
                  ),
                ),
              );
            }),
      ),
    ),
  );

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  initialSize: number;
  minSize: number;
  maxSize: number;
  controlledPane?: 'first' | 'second' | undefined;
  collapsed?: boolean | undefined;
  onResizeEnd?: ((size: number) => void) | undefined;
  first: ReactNode;
  second: ReactNode;
  style?: CSSProperties | undefined;
}

export const SplitPane = ({
  direction,
  initialSize,
  minSize,
  maxSize,
  controlledPane = 'first',
  collapsed = false,
  onResizeEnd,
  first,
  second,
  style,
}: SplitPaneProps): ReactElement => {
  const [size, setSize] = useState(() => Math.min(maxSize, Math.max(minSize, initialSize)));
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const clamp = useCallback(
    (v: number) => Math.min(maxSize, Math.max(minSize, Math.round(v))),
    [minSize, maxSize],
  );

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const startSize = sizeRef.current;
    const sign = controlledPane === 'first' ? 1 : -1;

    const onMove = (ev: MouseEvent) => {
      const cur = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const next = clamp(startSize + (cur - startPos) * sign);
      setSize(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onResizeEnd?.(sizeRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 14;
    const sign = controlledPane === 'first' ? 1 : -1;
    let delta = 0;
    if (direction === 'horizontal') {
      if (e.key === 'ArrowRight') delta = step * sign;
      if (e.key === 'ArrowLeft') delta = -step * sign;
    } else {
      if (e.key === 'ArrowDown') delta = step * sign;
      if (e.key === 'ArrowUp') delta = -step * sign;
    }
    if (delta !== 0) {
      e.preventDefault();
      const next = clamp(size + delta);
      setSize(next);
      onResizeEnd?.(next);
    }
  };

  const isHorizontal = direction === 'horizontal';
  const fixedStyle: CSSProperties = isHorizontal
    ? {
        width: size,
        maxWidth: 'calc(100% - 140px)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      }
    : {
        height: size,
        maxHeight: 'calc(100% - 120px)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
      };
  const flexStyle: CSSProperties = {
    flex: '1 1 0%',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  };

  if (collapsed) {
    return h(
      'div',
      {
        style: {
          display: 'flex',
          flexDirection: isHorizontal ? 'row' : 'column',
          flex: '1 1 0%',
          width: '100%',
          height: '100%',
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
          ...style,
        },
      },
      h('div', { style: flexStyle }, controlledPane === 'first' ? second : first),
    );
  }

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: isHorizontal ? 'row' : 'column',
        flex: '1 1 0%',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        ...style,
      },
    },
    h('div', { style: controlledPane === 'first' ? fixedStyle : flexStyle }, first),
    h('div', {
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': isHorizontal ? 'vertical' : 'horizontal',
      'aria-valuenow': size,
      'aria-valuemin': minSize,
      'aria-valuemax': maxSize,
      onMouseDown,
      onKeyDown,
      className: 'db-splitter',
      style: {
        flexShrink: 0,
        width: isHorizontal ? 4 : '100%',
        height: isHorizontal ? '100%' : 4,
        cursor: isHorizontal ? 'col-resize' : 'row-resize',
        background: tokens.color.border,
      },
    }),
    h('div', { style: controlledPane === 'second' ? fixedStyle : flexStyle }, second),
  );
};
