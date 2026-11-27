import { useCallback, useEffect, useState } from 'react';
import type { IpcChannelKey, IpcInput, IpcOutput, Project, SystemInfo } from '@devbrain/contracts';
import { tokens } from '@devbrain/ui';

/**
 * Foundation shell (Etapa 00). Proves the secure Main ⇄ Preload ⇄ Renderer path end to end.
 * The real UI is owned by Antigravity (Phase 01).
 */
const call = async <K extends IpcChannelKey>(key: K, input: IpcInput<K>): Promise<IpcOutput<K>> => {
  const response = await window.devbrain.invoke(key, input);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.data;
};

const styles = {
  page: {
    minHeight: '100vh',
    margin: 0,
    padding: tokens.space.xl,
    background: tokens.color.background,
    color: tokens.color.text,
    fontFamily: tokens.font.sans,
    boxSizing: 'border-box',
  },
  card: {
    background: tokens.color.surface,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.lg,
    padding: tokens.space.lg,
    marginBottom: tokens.space.lg,
  },
  button: {
    background: tokens.color.accent,
    color: tokens.color.background,
    border: 'none',
    borderRadius: tokens.radius.md,
    padding: `${tokens.space.sm} ${tokens.space.md}`,
    fontWeight: 600,
    cursor: 'pointer',
  },
  muted: { color: tokens.color.textMuted, fontSize: 13 },
  mono: { fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.textMuted },
} as const satisfies Record<string, React.CSSProperties>;

export const App = () => {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await call('system.getInfo', {}));
      setProjects(await call('projects.list', {}));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addProject = async () => {
    try {
      const rootPath = await call('projects.pickDirectory', {});
      if (!rootPath) return;
      await call('projects.register', { rootPath });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <main style={styles.page}>
      <h1 style={{ marginTop: 0 }}>DevBrain AI</h1>
      <p style={styles.muted}>Fundação arquitetural — Etapa 00</p>

      {error && (
        <section style={{ ...styles.card, borderColor: tokens.color.danger }} role="alert">
          {error}
        </section>
      )}

      <section style={styles.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Projetos</h2>
          <button type="button" style={styles.button} onClick={() => void addProject()}>
            Adicionar projeto
          </button>
        </div>
        {projects.length === 0 ? (
          <p style={styles.muted}>Nenhum projeto registrado.</p>
        ) : (
          <ul style={{ paddingLeft: tokens.space.md }}>
            {projects.map((p) => (
              <li key={p.id} style={{ marginBottom: tokens.space.sm }}>
                <strong>{p.name}</strong>{' '}
                {p.isGitRepository && <span style={styles.muted}>(git)</span>}
                <div style={styles.mono}>{p.rootPath}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {info && (
        <footer style={styles.mono}>
          app {info.appVersion} · contracts {info.contractsVersion} · electron{' '}
          {info.electronVersion} · node {info.nodeVersion} · db{' '}
          {info.dataDirectoryConfigured ? 'ok' : 'indisponível'}
        </footer>
      )}
    </main>
  );
};
