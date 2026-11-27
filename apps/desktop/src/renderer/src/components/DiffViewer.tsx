import { useMemo, useState } from 'react';
import type { GitDiff, GitStatus } from '@devbrain/contracts';
import { Badge, Banner, Button, EmptyState, Select, tokens } from '@devbrain/ui';
import { FileDiff, RefreshCw } from 'lucide-react';
import type { AppLanguage } from '../lib/i18n';

export interface ParsedFileDiff {
  header: string;
  filePath: string;
  additions: number;
  deletions: number;
  lines: { kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'; text: string }[];
}

export const parseUnifiedDiff = (raw: string): ParsedFileDiff[] => {
  if (!raw.trim()) return [];
  const sections = raw.split(/^diff --git /m).filter(Boolean);
  return sections.map((chunk) => {
    const rawLines = `diff --git ${chunk}`.split(/\r?\n/);
    const first = rawLines[0] ?? '';
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(first);
    const filePath = match?.[2] ?? first;
    let additions = 0;
    let deletions = 0;
    const lines = rawLines.map((line) => {
      if (
        line.startsWith('diff --git ') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file') ||
        line.startsWith('deleted file')
      ) {
        return { kind: 'meta' as const, text: line };
      }
      if (line.startsWith('@@')) return { kind: 'hunk' as const, text: line };
      if (line.startsWith('+')) {
        additions += 1;
        return { kind: 'add' as const, text: line };
      }
      if (line.startsWith('-')) {
        deletions += 1;
        return { kind: 'del' as const, text: line };
      }
      return { kind: 'ctx' as const, text: line };
    });
    return { header: first, filePath, additions, deletions, lines };
  });
};

export interface DiffViewerProps {
  gitStatus: GitStatus | null;
  gitDiff: GitDiff | null;
  loading: boolean;
  onRefresh: () => void;
  language: AppLanguage;
}

export const DiffViewer = ({
  gitStatus,
  gitDiff,
  loading,
  onRefresh,
  language,
}: DiffViewerProps) => {
  const pt = language === 'pt-BR';
  const [selectedFile, setSelectedFile] = useState<string>('__all__');

  const files = useMemo(() => parseUnifiedDiff(gitDiff?.diff ?? ''), [gitDiff?.diff]);
  const untracked = useMemo(
    () => (gitStatus?.files ?? []).filter((f) => f.workTree === 'untracked'),
    [gitStatus?.files],
  );

  if (!gitStatus) {
    return (
      <div style={{ padding: 14 }}>
        <EmptyState
          icon={<FileDiff size={24} />}
          title={pt ? 'Workspace sem repositório Git' : 'Not a Git repository'}
          description={
            pt
              ? 'Este diretório não possui um repositório Git inicializado. Inicialize um repositório para inspecionar status e diffs.'
              : 'Initialize a Git repository in this directory to inspect status and diffs.'
          }
          actions={
            <Button size="sm" icon={<RefreshCw size={13} />} onClick={onRefresh} loading={loading}>
              {pt ? 'Verificar novamente' : 'Re-check'}
            </Button>
          }
        />
      </div>
    );
  }

  const visibleFiles =
    selectedFile === '__all__' ? files : files.filter((f) => f.filePath === selectedFile);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        gap: 10,
        padding: 12,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="info" mono>
            {gitStatus.branch ?? (pt ? 'HEAD destacado' : 'detached HEAD')}
          </Badge>
          <Badge tone={gitStatus.clean ? 'success' : 'warning'}>
            {gitStatus.clean
              ? pt
                ? 'Árvore limpa'
                : 'Clean working tree'
              : `${gitStatus.files.length} ${pt ? 'arquivo(s) alterado(s)' : 'changed file(s)'}`}
          </Badge>
          {gitStatus.ahead > 0 || gitStatus.behind > 0 ? (
            <Badge tone="outline" mono>
              +{gitStatus.ahead} / -{gitStatus.behind}
            </Badge>
          ) : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {files.length > 1 ? (
            <Select
              value={selectedFile}
              onChange={(e) => setSelectedFile(e.target.value)}
              style={{ width: 240, height: 28 }}
            >
              <option value="__all__">
                {pt ? `Todos os arquivos (${files.length})` : `All files (${files.length})`}
              </option>
              {files.map((f) => (
                <option key={f.filePath} value={f.filePath}>
                  {f.filePath}
                </option>
              ))}
            </Select>
          ) : null}
          <Button
            size="xs"
            variant="secondary"
            icon={<RefreshCw size={12} />}
            loading={loading}
            onClick={onRefresh}
          >
            {pt ? 'Atualizar diff' : 'Refresh diff'}
          </Button>
        </div>
      </div>

      {gitDiff?.truncated ? (
        <Banner tone="warning">
          {pt
            ? 'O diff excedeu o limite seguro de leitura IPC (2 MiB) e foi truncado para manter a responsividade.'
            : 'Diff exceeded the 2 MiB IPC limit and was truncated.'}
        </Banner>
      ) : null}

      {untracked.length > 0 ? (
        <div className="db-card" style={{ padding: '8px 12px' }}>
          <div
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              marginBottom: 4,
              color: tokens.color.textMuted,
            }}
          >
            {pt
              ? `Arquivos novos não rastreados pelo Git (${untracked.length})`
              : `Untracked new files (${untracked.length})`}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {untracked.map((u) => (
              <Badge key={u.path} tone="success" mono>
                + {u.path}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {visibleFiles.length === 0 ? (
        <EmptyState
          icon={<FileDiff size={22} />}
          title={pt ? 'Sem diferenças em arquivos rastreados' : 'No tracked file diffs'}
          description={
            untracked.length > 0
              ? pt
                ? 'Há arquivos novos não rastreados listados acima; nenhum arquivo já rastreado possui alterações unstaged.'
                : 'Only untracked files exist; tracked files have no unstaged modifications.'
              : pt
                ? 'Nenhuma modificação pendente na árvore de trabalho.'
                : 'No pending modifications in the working tree.'
          }
        />
      ) : (
        visibleFiles.map((file) => (
          <div
            key={file.filePath}
            data-untrusted="true"
            style={{
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              overflow: 'hidden',
              background: tokens.color.surface,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                padding: '6px 10px',
                background: tokens.color.surfaceElevated,
                borderBottom: `1px solid ${tokens.color.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span className="db-mono" style={{ fontSize: 12, fontWeight: 600 }}>
                {file.filePath}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Badge tone="success" mono>
                  +{file.additions}
                </Badge>
                <Badge tone="danger" mono>
                  -{file.deletions}
                </Badge>
              </div>
            </div>
            <div style={{ overflowX: 'auto', padding: '4px 0' }}>
              {file.lines.map((ln, idx) => (
                <div
                  key={idx}
                  className={[
                    'db-diff-line',
                    ln.kind === 'add'
                      ? 'db-diff-add'
                      : ln.kind === 'del'
                        ? 'db-diff-del'
                        : ln.kind === 'hunk'
                          ? 'db-diff-hunk'
                          : ln.kind === 'meta'
                            ? 'db-faint'
                            : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {ln.text || ' '}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
};
