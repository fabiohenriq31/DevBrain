import {
  createElement as h,
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { tokens } from './tokens.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  loading?: boolean | undefined;
  icon?: ReactNode | undefined;
  active?: boolean | undefined;
}

const variantStyle: Record<ButtonVariant, CSSProperties> = {
  primary: {
    background: tokens.color.accent,
    color: tokens.color.accentText,
    border: '1px solid transparent',
    fontWeight: 600,
  },
  secondary: {
    background: tokens.color.surfaceElevated,
    color: tokens.color.text,
    border: `1px solid ${tokens.color.borderStrong}`,
    fontWeight: 500,
  },
  ghost: {
    background: 'transparent',
    color: tokens.color.textMuted,
    border: '1px solid transparent',
    fontWeight: 500,
  },
  danger: {
    background: tokens.color.dangerSubtle,
    color: tokens.color.danger,
    border: `1px solid ${tokens.color.danger}`,
    fontWeight: 600,
  },
  warning: {
    background: tokens.color.warningSubtle,
    color: tokens.color.warning,
    border: `1px solid ${tokens.color.warning}`,
    fontWeight: 600,
  },
};

const sizeStyle: Record<ButtonSize, CSSProperties> = {
  xs: { height: 24, padding: '0 8px', fontSize: 11, gap: 4 },
  sm: { height: 28, padding: '0 10px', fontSize: 12, gap: 6 },
  md: { height: 32, padding: '0 12px', fontSize: 13, gap: 6 },
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'sm',
    loading = false,
    icon,
    active = false,
    disabled,
    style,
    children,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = Boolean(disabled || loading);
  return h(
    'button',
    {
      ...rest,
      ref,
      type,
      disabled: isDisabled,
      'aria-busy': loading || undefined,
      'data-active': active || undefined,
      className: ['db-btn', `db-btn-${variant}`, className].filter(Boolean).join(' '),
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.radius.md,
        fontFamily: tokens.font.sans,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.55 : 1,
        userSelect: 'none',
        ...variantStyle[variant],
        ...(active && variant === 'ghost'
          ? {
              background: tokens.color.accentSubtle,
              color: tokens.color.accent,
              borderColor: tokens.color.border,
            }
          : {}),
        ...sizeStyle[size],
        ...style,
      },
    },
    icon
      ? h(
          'span',
          { 'aria-hidden': 'true', style: { display: 'inline-flex', alignItems: 'center' } },
          icon,
        )
      : null,
    children,
  );
});

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'outline';

export interface BadgeProps {
  tone?: BadgeTone | undefined;
  dot?: boolean | undefined;
  mono?: boolean | undefined;
  title?: string | undefined;
  children?: ReactNode;
}

const badgeTones: Record<BadgeTone, CSSProperties> = {
  neutral: {
    background: tokens.color.surfaceElevated,
    color: tokens.color.textMuted,
    border: `1px solid ${tokens.color.border}`,
  },
  info: {
    background: tokens.color.accentSubtle,
    color: tokens.color.accent,
    border: '1px solid transparent',
  },
  success: {
    background: tokens.color.successSubtle,
    color: tokens.color.success,
    border: '1px solid transparent',
  },
  warning: {
    background: tokens.color.warningSubtle,
    color: tokens.color.warning,
    border: '1px solid transparent',
  },
  danger: {
    background: tokens.color.dangerSubtle,
    color: tokens.color.danger,
    border: '1px solid transparent',
  },
  outline: {
    background: 'transparent',
    color: tokens.color.textMuted,
    border: `1px solid ${tokens.color.borderStrong}`,
  },
};

export const Badge = ({
  tone = 'neutral',
  dot = false,
  mono = false,
  title,
  children,
}: BadgeProps): ReactElement =>
  h(
    'span',
    {
      title,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 20,
        padding: '0 7px',
        borderRadius: tokens.radius.sm,
        fontSize: 11,
        fontWeight: 500,
        fontFamily: mono ? tokens.font.mono : tokens.font.sans,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...badgeTones[tone],
      },
    },
    dot
      ? h('span', {
          'aria-hidden': 'true',
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            flexShrink: 0,
          },
        })
      : null,
    children,
  );

export const KeyHint = ({ keys }: { keys: string }): ReactElement =>
  h(
    'kbd',
    {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 5px',
        borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.color.borderStrong}`,
        background: tokens.color.surface,
        color: tokens.color.textFaint,
        fontFamily: tokens.font.mono,
        fontSize: 10,
        lineHeight: 1,
      },
    },
    keys,
  );

export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}

export interface FieldProps {
  label: string;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  required?: boolean | undefined;
  htmlFor?: string | undefined;
  rightSlot?: ReactNode | undefined;
  children: (controlProps: FieldControlProps) => ReactNode;
}

export const Field = ({
  label,
  hint,
  error,
  required,
  htmlFor,
  rightSlot,
  children,
}: FieldProps): ReactElement => {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const descId = error || hint ? `${id}-desc` : undefined;
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h(
        'label',
        { htmlFor: id, style: { fontSize: 12, fontWeight: 600, color: tokens.color.text } },
        label,
        required ? h('span', { style: { color: tokens.color.danger, marginLeft: 3 } }, '*') : null,
      ),
      rightSlot ?? null,
    ),
    children({
      id,
      ...(error ? { 'aria-invalid': true as const } : {}),
      ...(descId ? { 'aria-describedby': descId } : {}),
    }),
    error
      ? h(
          'span',
          { id: descId, role: 'alert', style: { fontSize: 11, color: tokens.color.danger } },
          error,
        )
      : hint
        ? h('span', { id: descId, style: { fontSize: 11, color: tokens.color.textMuted } }, hint)
        : null,
  );
};

const baseControlStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  fontFamily: tokens.font.sans,
  fontSize: 12.5,
  padding: '6px 9px',
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean | undefined;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono = false, style, className, ...rest },
  ref,
) {
  return h('input', {
    ...rest,
    ref,
    className: ['db-input', className].filter(Boolean).join(' '),
    style: {
      ...baseControlStyle,
      height: 30,
      fontFamily: mono ? tokens.font.mono : tokens.font.sans,
      ...style,
    },
  });
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean | undefined;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono = false, style, className, ...rest },
  ref,
) {
  return h('textarea', {
    ...rest,
    ref,
    className: ['db-textarea', className].filter(Boolean).join(' '),
    style: {
      ...baseControlStyle,
      minHeight: 72,
      resize: 'vertical',
      lineHeight: 1.45,
      fontFamily: mono ? tokens.font.mono : tokens.font.sans,
      ...style,
    },
  });
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ style, className, children, ...rest }, ref) {
    return h(
      'select',
      {
        ...rest,
        ref,
        className: ['db-select', className].filter(Boolean).join(' '),
        style: {
          ...baseControlStyle,
          height: 30,
          padding: '0 8px',
          lineHeight: 1.2,
          ...style,
        },
      },
      children,
    );
  },
);

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode | undefined;
}

export const Checkbox = ({
  label,
  description,
  id,
  style,
  ...rest
}: CheckboxProps): ReactElement => {
  const autoId = useId();
  const inputId = id ?? autoId;
  return h(
    'label',
    {
      htmlFor: inputId,
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        fontSize: 12.5,
        color: tokens.color.text,
        ...style,
      },
    },
    h('input', { ...rest, id: inputId, type: 'checkbox', style: { marginTop: 2 } }),
    h(
      'span',
      { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('span', { style: { fontWeight: 500 } }, label),
      description
        ? h('span', { style: { fontSize: 11.5, color: tokens.color.textMuted } }, description)
        : null,
    ),
  );
};

export type BannerTone = 'info' | 'success' | 'warning' | 'danger';

export interface BannerProps {
  tone?: BannerTone | undefined;
  title?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  actions?: ReactNode | undefined;
  children?: ReactNode;
}

const bannerToneStyle: Record<BannerTone, CSSProperties> = {
  info: {
    background: tokens.color.accentSubtle,
    borderColor: tokens.color.accent,
    color: tokens.color.text,
  },
  success: {
    background: tokens.color.successSubtle,
    borderColor: tokens.color.success,
    color: tokens.color.text,
  },
  warning: {
    background: tokens.color.warningSubtle,
    borderColor: tokens.color.warning,
    color: tokens.color.text,
  },
  danger: {
    background: tokens.color.dangerSubtle,
    borderColor: tokens.color.danger,
    color: tokens.color.text,
  },
};

export const Banner = ({
  tone = 'info',
  title,
  icon,
  actions,
  children,
}: BannerProps): ReactElement =>
  h(
    'div',
    {
      role: tone === 'danger' || tone === 'warning' ? 'alert' : 'status',
      style: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        padding: '9px 12px',
        borderRadius: tokens.radius.md,
        border: '1px solid',
        fontSize: 12.5,
        lineHeight: 1.45,
        minWidth: 0,
        flexShrink: 0,
        ...bannerToneStyle[tone],
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'flex-start', gap: 9, minWidth: 0 } },
      icon
        ? h('span', { 'aria-hidden': 'true', style: { marginTop: 1, flexShrink: 0 } }, icon)
        : null,
      h(
        'div',
        { style: { minWidth: 0 } },
        title ? h('div', { style: { fontWeight: 600, marginBottom: 2 } }, title) : null,
        h('div', { style: { color: tokens.color.text } }, children),
      ),
    ),
    actions
      ? h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
          actions,
        )
      : null,
  );

export interface EmptyStateProps {
  icon?: ReactNode | undefined;
  title: string;
  description: string;
  actions?: ReactNode | undefined;
}

export const EmptyState = ({ icon, title, description, actions }: EmptyStateProps): ReactElement =>
  h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '28px 20px',
        border: `1px dashed ${tokens.color.borderStrong}`,
        borderRadius: tokens.radius.lg,
        background: tokens.color.surface,
        gap: 8,
        minWidth: 0,
        flexShrink: 0,
      },
    },
    icon
      ? h('div', { 'aria-hidden': 'true', style: { color: tokens.color.textFaint } }, icon)
      : null,
    h('div', { style: { fontSize: 13.5, fontWeight: 600, color: tokens.color.text } }, title),
    h(
      'div',
      { style: { fontSize: 12, color: tokens.color.textMuted, maxWidth: 420, lineHeight: 1.45 } },
      description,
    ),
    actions
      ? h('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } }, actions)
      : null,
  );

export interface UntrustedBlockProps {
  text: string;
  maxHeight?: number | string | undefined;
  label?: string | undefined;
}

export const UntrustedBlock = ({
  text,
  maxHeight = 280,
  label,
}: UntrustedBlockProps): ReactElement =>
  h(
    'div',
    {
      'data-untrusted': 'true',
      style: {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 0,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.background,
        overflow: 'hidden',
      },
    },
    label
      ? h(
          'div',
          {
            style: {
              padding: '4px 8px',
              borderBottom: `1px solid ${tokens.color.border}`,
              fontSize: 10.5,
              color: tokens.color.textFaint,
              fontFamily: tokens.font.mono,
              display: 'flex',
              justifyContent: 'space-between',
            },
          },
          h('span', null, label),
          h('span', null, 'texto não confiável (somente leitura)'),
        )
      : null,
    h(
      'pre',
      {
        'data-scroll-region': 'untrusted-block',
        style: {
          margin: 0,
          padding: '8px 10px',
          maxHeight,
          overflowX: 'auto',
          overflowY: 'auto',
          fontFamily: tokens.font.mono,
          fontSize: 11.5,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          color: tokens.color.text,
        },
      },
      text,
    ),
  );
