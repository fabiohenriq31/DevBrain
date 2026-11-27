/**
 * Non-secret UI layout preferences stored locally in the renderer profile.
 * SECURITY INVARIANT (docs/SECURITY.md): NEVER store credentials, tokens, paths with secrets,
 * or sensitive payloads in localStorage. Only allowlisted layout/onboarding keys are accepted.
 */
export interface UiPreferences {
  onboardingState: 'pending' | 'skipped' | 'completed';
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  terminalAutoScroll: boolean;
  terminalExpanded: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  terminalHeight: number;
  activeProjectId: string | null;
}

const STORAGE_KEY = 'devbrain.ui.preferences.v1';

export const DEFAULT_UI_PREFERENCES: UiPreferences = Object.freeze({
  onboardingState: 'pending',
  sidebarCollapsed: false,
  inspectorOpen: true,
  terminalAutoScroll: true,
  terminalExpanded: false,
  sidebarWidth: 220,
  inspectorWidth: 300,
  terminalHeight: 320,
  activeProjectId: null,
});

const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

export const parseUiPreferences = (raw: string | null): UiPreferences => {
  if (!raw) return { ...DEFAULT_UI_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const onboarding =
      parsed.onboardingState === 'completed' || parsed.onboardingState === 'skipped'
        ? parsed.onboardingState
        : 'pending';
    return {
      onboardingState: onboarding,
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === 'boolean'
          ? parsed.sidebarCollapsed
          : DEFAULT_UI_PREFERENCES.sidebarCollapsed,
      inspectorOpen:
        typeof parsed.inspectorOpen === 'boolean'
          ? parsed.inspectorOpen
          : DEFAULT_UI_PREFERENCES.inspectorOpen,
      terminalAutoScroll:
        typeof parsed.terminalAutoScroll === 'boolean'
          ? parsed.terminalAutoScroll
          : DEFAULT_UI_PREFERENCES.terminalAutoScroll,
      terminalExpanded:
        typeof parsed.terminalExpanded === 'boolean'
          ? parsed.terminalExpanded
          : DEFAULT_UI_PREFERENCES.terminalExpanded,
      sidebarWidth: clampInt(parsed.sidebarWidth, DEFAULT_UI_PREFERENCES.sidebarWidth, 180, 360),
      inspectorWidth: clampInt(
        parsed.inspectorWidth,
        DEFAULT_UI_PREFERENCES.inspectorWidth,
        240,
        480,
      ),
      terminalHeight: clampInt(
        parsed.terminalHeight,
        DEFAULT_UI_PREFERENCES.terminalHeight,
        180,
        640,
      ),
      activeProjectId:
        typeof parsed.activeProjectId === 'string' && parsed.activeProjectId.startsWith('prj_')
          ? parsed.activeProjectId
          : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
};

export const loadUiPreferences = (): UiPreferences => {
  try {
    return parseUiPreferences(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
};

export const saveUiPreferences = (prefs: UiPreferences): void => {
  try {
    const safe: UiPreferences = {
      onboardingState: prefs.onboardingState,
      sidebarCollapsed: prefs.sidebarCollapsed,
      inspectorOpen: prefs.inspectorOpen,
      terminalAutoScroll: prefs.terminalAutoScroll,
      terminalExpanded: prefs.terminalExpanded,
      sidebarWidth: clampInt(prefs.sidebarWidth, DEFAULT_UI_PREFERENCES.sidebarWidth, 180, 360),
      inspectorWidth: clampInt(
        prefs.inspectorWidth,
        DEFAULT_UI_PREFERENCES.inspectorWidth,
        240,
        480,
      ),
      terminalHeight: clampInt(
        prefs.terminalHeight,
        DEFAULT_UI_PREFERENCES.terminalHeight,
        180,
        640,
      ),
      activeProjectId:
        prefs.activeProjectId && prefs.activeProjectId.startsWith('prj_')
          ? prefs.activeProjectId
          : null,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* ignore storage unavailability */
  }
};
