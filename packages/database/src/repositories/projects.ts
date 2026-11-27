import {
  ProjectSchema,
  ProjectSettingsSchema,
  TechnologySchema,
  WorkspaceAccessPolicySchema,
  WorkspaceSchema,
  type Project,
  type ProjectSettings,
  type Workspace,
} from '@devbrain/contracts';
import { z } from 'zod';
import type { SqlDriver, SqlRow } from '../driver.js';
import { fromJson, json, notFound, pathKey, validated } from './common.js';

interface ProjectRow extends SqlRow {
  id: string;
  name: string;
  root_path: string;
  description: string | null;
  is_git_repository: number;
  default_workspace_id: string | null;
  metadata: string;
  technologies: string;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const toProject = (row: ProjectRow): Project =>
  validated(
    ProjectSchema,
    {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      description: row.description,
      isGitRepository: Number(row.is_git_repository) === 1,
      defaultWorkspaceId: row.default_workspace_id,
      metadata: fromJson(z.record(z.string(), z.unknown()), row.metadata, 'project metadata'),
      technologies: fromJson(z.array(TechnologySchema), row.technologies, 'technologies'),
      lastOpenedAt: row.last_opened_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    },
    'stored project',
  );

const params = (p: Project) => ({
  id: p.id,
  name: p.name,
  rootPath: p.rootPath,
  key: pathKey(p.rootPath),
  description: p.description,
  git: p.isGitRepository ? 1 : 0,
  ws: p.defaultWorkspaceId,
  metadata: json(p.metadata),
  technologies: json(p.technologies),
  lastOpenedAt: p.lastOpenedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  archivedAt: p.archivedAt,
});

export class ProjectRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(project: Project): Project {
    const valid = validated(ProjectSchema, project, 'project');
    this.db.run(
      `INSERT INTO projects (id, name, root_path, root_path_key, description, is_git_repository,
         default_workspace_id, metadata, technologies, last_opened_at, created_at, updated_at, archived_at)
       VALUES (:id, :name, :rootPath, :key, :description, :git, :ws, :metadata, :technologies,
         :lastOpenedAt, :createdAt, :updatedAt, :archivedAt)`,
      params(valid),
    );
    return valid;
  }

  update(project: Project): Project {
    const valid = validated(ProjectSchema, project, 'project');
    const { changes } = this.db.run(
      `UPDATE projects SET name = :name, description = :description, is_git_repository = :git,
         default_workspace_id = :ws, metadata = :metadata, technologies = :technologies,
         last_opened_at = :lastOpenedAt, updated_at = :updatedAt, archived_at = :archivedAt
       WHERE id = :id`,
      // root_path and created_at are immutable: only the columns used above are bound.
      (({ rootPath: _rootPath, key: _key, createdAt: _createdAt, ...rest }) => rest)(params(valid)),
    );
    if (changes === 0) throw notFound('Project', valid.id);
    return valid;
  }

  /** Deletes the registration; cascades to workspaces, sessions, executions, checkpoints. */
  delete(id: string): void {
    const { changes } = this.db.run('DELETE FROM projects WHERE id = :id', { id });
    if (changes === 0) throw notFound('Project', id);
  }

  findById(id: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = :id', { id });
    return row ? toProject(row) : null;
  }

  findByRootPath(rootPath: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE root_path_key = :key', {
      key: pathKey(rootPath),
    });
    return row ? toProject(row) : null;
  }

  list(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE';
    return this.db.all<ProjectRow>(sql).map(toProject);
  }

  listRecent(limit: number): Project[] {
    return this.db
      .all<ProjectRow>(
        `SELECT * FROM projects WHERE archived_at IS NULL AND last_opened_at IS NOT NULL
         ORDER BY last_opened_at DESC LIMIT :limit`,
        { limit },
      )
      .map(toProject);
  }
}

// ---------------------------------------------------------------------------

interface WorkspaceRow extends SqlRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  root_path: string;
  branch: string | null;
  access: string;
  created_at: string;
  updated_at: string;
}

const toWorkspace = (row: WorkspaceRow): Workspace =>
  validated(
    WorkspaceSchema,
    {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      kind: row.kind,
      rootPath: row.root_path,
      branch: row.branch,
      access: fromJson(WorkspaceAccessPolicySchema, row.access, 'workspace access'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    'stored workspace',
  );

export class WorkspaceRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(workspace: Workspace): Workspace {
    const w = validated(WorkspaceSchema, workspace, 'workspace');
    this.db.run(
      `INSERT INTO workspaces (id, project_id, name, kind, root_path, branch, access, created_at, updated_at)
       VALUES (:id, :projectId, :name, :kind, :rootPath, :branch, :access, :createdAt, :updatedAt)`,
      {
        id: w.id,
        projectId: w.projectId,
        name: w.name,
        kind: w.kind,
        rootPath: w.rootPath,
        branch: w.branch,
        access: json(w.access),
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      },
    );
    return w;
  }

  update(workspace: Workspace): Workspace {
    const w = validated(WorkspaceSchema, workspace, 'workspace');
    const { changes } = this.db.run(
      `UPDATE workspaces SET name = :name, branch = :branch, access = :access, updated_at = :updatedAt
       WHERE id = :id`,
      { id: w.id, name: w.name, branch: w.branch, access: json(w.access), updatedAt: w.updatedAt },
    );
    if (changes === 0) throw notFound('Workspace', w.id);
    return w;
  }

  findById(id: string): Workspace | null {
    const row = this.db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = :id', { id });
    return row ? toWorkspace(row) : null;
  }

  listByProject(projectId: string): Workspace[] {
    return this.db
      .all<WorkspaceRow>(
        'SELECT * FROM workspaces WHERE project_id = :projectId ORDER BY created_at',
        { projectId },
      )
      .map(toWorkspace);
  }
}

// ---------------------------------------------------------------------------

export class ProjectSettingsRepository {
  constructor(private readonly db: SqlDriver) {}

  get(projectId: string): ProjectSettings | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM project_settings WHERE project_id = :projectId',
      { projectId },
    );
    return row ? fromJson(ProjectSettingsSchema, row.data, 'project settings') : null;
  }

  save(settings: ProjectSettings): ProjectSettings {
    const s = validated(ProjectSettingsSchema, settings, 'project settings');
    this.db.run(
      `INSERT INTO project_settings (project_id, data, updated_at) VALUES (:projectId, :data, :at)
       ON CONFLICT(project_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      { projectId: s.projectId, data: json(s), at: s.updatedAt },
    );
    return s;
  }
}
