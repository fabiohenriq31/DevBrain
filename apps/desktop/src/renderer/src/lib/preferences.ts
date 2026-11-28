import type { StrategyPresetId } from './ai-center';

/**
 * Non-secret UI layout & workflow preferences stored locally in the renderer profile.
 * SECURITY INVARIANT (docs/SECURITY.md): NEVER store credentials, tokens, paths with secrets,
 * or sensitive payloads in localStorage. Only allowlisted keys are accepted and sanitized.
 */
export interface AssistedSignupQueueItem {
  providerId: string;
  providerName: string;
  currentStep: number;
  status: 'queued' | 'in-progress' | 'completed';
  updatedAt: string;
}

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
  signupQueue: AssistedSignupQueueItem[];
  selectedStrategyPreset: StrategyPresetId;
}

const STORAGE_KEY = 'devbrain.ui.preferences.v1';

const VALID_STRATEGY: ReadonlySet<StrategyPresetId> = new Set([
  'free-only',
  'local-only',
  'max-savings',
  'balanced',
  'max-quality',
  'custom',
]);

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
  signupQueue: [],
  selectedStrategyPreset: 'balanced',
});

const clampInt = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

const sanitizeSignupQueue = (raw: unknown): AssistedSignupQueueItem[] => {
  if (!Array.isArray(raw)) return [];
  const items: AssistedSignupQueueItem[] = [];
  for (const item of raw.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.providerId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(rec.providerId)
    ) {
      continue;
    }
    const providerName =
      typeof rec.providerName === 'string' ? rec.providerName.slice(0, 120) : rec.providerId;
    const status =
      rec.status === 'completed' || rec.status === 'in-progress' ? rec.status : 'queued';
    items.push({
      providerId: rec.providerId,
      providerName,
      currentStep: clampInt(rec.currentStep, 1, 1, 11),
      status,
      updatedAt:
        typeof rec.updatedAt === 'string' ? rec.updatedAt.slice(0, 40) : new Date().toISOString(),
    });
  }
  return items;
};

export const parseUiPreferences = (raw: string | null): UiPreferences => {
  if (!raw)
    return {
      ...DEFAULT_UI_PREFERENCES,
      signupQueue: [],
    };
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
      signupQueue: sanitizeSignupQueue(parsed.signupQueue),
      selectedStrategyPreset:
        typeof parsed.selectedStrategyPreset === 'string' &&
        VALID_STRATEGY.has(parsed.selectedStrategyPreset as StrategyPresetId)
          ? (parsed.selectedStrategyPreset as StrategyPresetId)
          : DEFAULT_UI_PREFERENCES.selectedStrategyPreset,
    };
  } catch {
    return {
      ...DEFAULT_UI_PREFERENCES,
      signupQueue: [],
    };
  }
};

export const loadUiPreferences = (): UiPreferences => {
  try {
    return parseUiPreferences(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {
      ...DEFAULT_UI_PREFERENCES,
      signupQueue: [],
    };
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
      signupQueue: sanitizeSignupQueue(prefs.signupQueue),
      selectedStrategyPreset: VALID_STRATEGY.has(prefs.selectedStrategyPreset)
        ? prefs.selectedStrategyPreset
        : 'balanced',
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  } catch {
    /* ignore storage unavailability */
  }
};
