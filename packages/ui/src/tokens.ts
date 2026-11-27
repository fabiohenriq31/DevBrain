/**
 * @devbrain/ui — Design tokens & theme CSS variables (Dark + Light).
 * Owner: Antigravity.
 *
 * Calibrated for dense, high-contrast engineering interfaces (Linear / VS Code / GitHub Desktop):
 * restrained border radii (3px–8px), crisp 1px hairlines, zero decorative gradients.
 */
export const tokens = {
  color: {
    background: 'var(--db-bg, #0d1016)',
    surface: 'var(--db-surface, #131720)',
    surfaceElevated: 'var(--db-surface-2, #181d28)',
    surfaceHover: 'var(--db-surface-hover, #1e2432)',
    border: 'var(--db-border, #232a38)',
    borderStrong: 'var(--db-border-strong, #323c50)',
    text: 'var(--db-text, #e6eaf2)',
    textMuted: 'var(--db-text-muted, #939db0)',
    textFaint: 'var(--db-text-faint, #657086)',
    accent: 'var(--db-accent, #4c9aff)',
    accentHover: 'var(--db-accent-hover, #69abff)',
    accentSubtle: 'var(--db-accent-subtle, rgba(76, 154, 255, 0.14))',
    accentText: 'var(--db-accent-contrast, #08101d)',
    success: 'var(--db-success, #36c688)',
    successSubtle: 'var(--db-success-subtle, rgba(54, 198, 136, 0.14))',
    warning: 'var(--db-warning, #e5a93c)',
    warningSubtle: 'var(--db-warning-subtle, rgba(229, 169, 60, 0.15))',
    danger: 'var(--db-danger, #eb5763)',
    dangerSubtle: 'var(--db-danger-subtle, rgba(235, 87, 99, 0.15))',
  },
  radius: { sm: '3px', md: '5px', lg: '7px' },
  space: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
  font: {
    sans: "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif",
    mono: "'Cascadia Code', 'Cascadia Mono', Consolas, 'Courier New', monospace",
  },
} as const;

export type Tokens = typeof tokens;

export type ThemePreference = 'system' | 'light' | 'dark';
export type EffectiveTheme = 'light' | 'dark';

export const resolveEffectiveTheme = (
  preference: ThemePreference,
  systemPrefersDark: boolean,
): EffectiveTheme => {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
};

export const THEME_CSS = `
:root, [data-theme="dark"] {
  color-scheme: dark;
  --db-bg: #0d1016;
  --db-titlebar: #0a0d12;
  --db-sidebar: #10141c;
  --db-surface: #131720;
  --db-surface-2: #181e29;
  --db-surface-hover: #1e2533;
  --db-surface-active: #232c3d;
  --db-border: #222938;
  --db-border-strong: #313b50;
  --db-text: #e6eaf2;
  --db-text-muted: #939db0;
  --db-text-faint: #667187;
  --db-accent: #4c9aff;
  --db-accent-hover: #68abff;
  --db-accent-subtle: rgba(76, 154, 255, 0.14);
  --db-accent-contrast: #07101d;
  --db-success: #36c688;
  --db-success-subtle: rgba(54, 198, 136, 0.14);
  --db-warning: #e5a93c;
  --db-warning-subtle: rgba(229, 169, 60, 0.15);
  --db-danger: #eb5763;
  --db-danger-subtle: rgba(235, 87, 99, 0.15);
  --db-focus: #4c9aff;
  --db-backdrop: rgba(4, 7, 12, 0.72);
  --db-diff-add-bg: rgba(54, 198, 136, 0.13);
  --db-diff-add-fg: #6ee2ad;
  --db-diff-del-bg: rgba(235, 87, 99, 0.14);
  --db-diff-del-fg: #ff8c95;
  --db-terminal-bg: #090c11;
  --db-terminal-fg: #dce2ee;
}

[data-theme="light"] {
  color-scheme: light;
  --db-bg: #f6f8fa;
  --db-titlebar: #edf0f5;
  --db-sidebar: #f0f3f7;
  --db-surface: #ffffff;
  --db-surface-2: #f3f5f9;
  --db-surface-hover: #e9edf4;
  --db-surface-active: #dfe6f0;
  --db-border: #d8dee8;
  --db-border-strong: #bcc5d4;
  --db-text: #161b24;
  --db-text-muted: #4f5b6e;
  --db-text-faint: #738096;
  --db-accent: #0b65d9;
  --db-accent-hover: #0954b5;
  --db-accent-subtle: rgba(11, 101, 217, 0.11);
  --db-accent-contrast: #ffffff;
  --db-success: #148050;
  --db-success-subtle: rgba(20, 128, 80, 0.11);
  --db-warning: #9e6300;
  --db-warning-subtle: rgba(158, 99, 0, 0.12);
  --db-danger: #c92a37;
  --db-danger-subtle: rgba(201, 42, 55, 0.11);
  --db-focus: #0b65d9;
  --db-backdrop: rgba(15, 22, 34, 0.45);
  --db-diff-add-bg: rgba(20, 128, 80, 0.12);
  --db-diff-add-fg: #0f6840;
  --db-diff-del-bg: rgba(201, 42, 55, 0.12);
  --db-diff-del-fg: #a51d28;
  --db-terminal-bg: #11151d;
  --db-terminal-fg: #e2e7f0;
}
`;
