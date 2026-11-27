/**
 * @devbrain/ui — owner: Antigravity.
 * Design tokens shared by the desktop renderer. React primitives are added in Phase 01.
 */
export const tokens = {
  color: {
    background: '#0f1115',
    surface: '#171a21',
    border: '#2a2f3a',
    text: '#e6e8ee',
    textMuted: '#9aa3b2',
    accent: '#6ea8fe',
    success: '#3ccf91',
    warning: '#f5b74f',
    danger: '#f0646e',
  },
  radius: { sm: '4px', md: '8px', lg: '12px' },
  space: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
  font: {
    sans: "'Segoe UI', system-ui, -apple-system, sans-serif",
    mono: "'Cascadia Code', Consolas, 'Courier New', monospace",
  },
} as const;

export type Tokens = typeof tokens;
