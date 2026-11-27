import type {
  AuditActor,
  AuditEventInput,
  IpcEventKey,
  IpcEventPayload,
} from '@devbrain/contracts';
import type { DevBrainDatabase } from '@devbrain/database';
import { NULL_LOGGER, redactValue, type Logger } from '@devbrain/security';

type Listener<K extends IpcEventKey> = (payload: IpcEventPayload<K>) => void;

/**
 * Typed in-process event bus. Keys and payloads are the IPC push events, so the desktop
 * shell can forward them to the renderer without translation.
 */
export class CoreEvents {
  private readonly listeners = new Map<IpcEventKey, Set<Listener<IpcEventKey>>>();

  on<K extends IpcEventKey>(key: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener as Listener<IpcEventKey>);
    return () => set.delete(listener as Listener<IpcEventKey>);
  }

  emit<K extends IpcEventKey>(key: K, payload: IpcEventPayload<K>): void {
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener(payload);
      } catch {
        // A failing subscriber must not break the emitting service.
      }
    }
  }
}

/** Dependencies shared by every core service. */
export interface CoreContext {
  db: DevBrainDatabase;
  events: CoreEvents;
  logger: Logger;
  /** Identifies this app run; live sessions are owned by it. */
  instanceId: string;
}

export const createContext = (
  db: DevBrainDatabase,
  options: { instanceId: string; logger?: Logger; events?: CoreEvents },
): CoreContext => ({
  db,
  events: options.events ?? new CoreEvents(),
  logger: options.logger ?? NULL_LOGGER,
  instanceId: options.instanceId,
});

/** Appends a redacted audit row (synchronously, inside the caller's transaction if any). */
export const audit = (
  ctx: CoreContext,
  input: Partial<AuditEventInput> & Pick<AuditEventInput, 'action'>,
): void => {
  const actor: AuditActor = input.actor ?? { type: 'user' };
  ctx.db.audit.appendSync({
    actor,
    action: input.action,
    permission: input.permission ?? null,
    projectId: input.projectId ?? null,
    target: input.target ?? null,
    outcome: input.outcome ?? 'success',
    details: redactValue(input.details ?? {}) as Record<string, unknown>,
    correlationId: input.correlationId ?? null,
  });
};

export const addMs = (ms: number, from = Date.now()): string => new Date(from + ms).toISOString();
