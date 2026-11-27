import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DevBrainError,
  ListProjectsInputSchema,
  RegisterProjectInputSchema,
  UpdateProjectInputSchema,
  newId,
  nowTimestamp,
  parseOrThrow,
  type ListProjectsInput,
  type Project,
  type ProjectService,
  type RegisterProjectInput,
  type UpdateProjectInput,
  type Workspace,
} from '@devbrain/contracts';
import type { DevBrainDatabase } from '@devbrain/database';
import { assertSafePathSyntax } from '@devbrain/security';

/** Directories that must never be registered as projects. */
const isForbiddenRoot = (resolved: string): boolean => {
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true; // drive / filesystem root
  const home = process.env['USERPROFILE'] ?? process.env['HOME'];
  if (home && path.resolve(home).toLowerCase() === resolved.toLowerCase()) return true;
  const sysRoot = process.env['SystemRoot'];
  return Boolean(sysRoot && resolved.toLowerCase().startsWith(path.resolve(sysRoot).toLowerCase()));
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

export class LocalProjectService implements ProjectService {
  constructor(private readonly db: DevBrainDatabase) {}

  async list(input: ListProjectsInput = {}): Promise<Project[]> {
    const { includeArchived } = parseOrThrow(ListProjectsInputSchema, input);
    return this.db.projects.list(includeArchived);
  }

  async get(id: string): Promise<Project> {
    const project = this.db.projects.findById(id);
    if (!project) throw new DevBrainError('NOT_FOUND', 'Project not found', { details: { id } });
    return project;
  }

  async register(input: RegisterProjectInput): Promise<Project> {
    const parsed = parseOrThrow(RegisterProjectInputSchema, input);
    assertSafePathSyntax(parsed.rootPath);
    const rootPath = path.resolve(parsed.rootPath);
    if (isForbiddenRoot(rootPath)) {
      throw new DevBrainError(
        'PERMISSION_DENIED',
        'This directory cannot be registered as a project',
        {
          details: { rootPath },
        },
      );
    }
    let info;
    try {
      info = await stat(rootPath);
    } catch {
      throw new DevBrainError('NOT_FOUND', 'Directory does not exist', { details: { rootPath } });
    }
    if (!info.isDirectory())
      throw new DevBrainError('VALIDATION_FAILED', 'Path is not a directory');
    if (this.db.projects.findByRootPath(rootPath)) {
      throw new DevBrainError(
        'ALREADY_EXISTS',
        'A project is already registered for this directory',
      );
    }

    const isGitRepository = await exists(path.join(rootPath, '.git'));
    const now = nowTimestamp();
    const projectId = newId('project');
    const workspace: Workspace = {
      id: newId('workspace'),
      projectId,
      name: 'primary',
      kind: 'primary',
      rootPath,
      branch: null,
      access: { allowedRoots: [rootPath], readOnlyRoots: [], allowNetwork: false },
      createdAt: now,
      updatedAt: now,
    };
    const project: Project = {
      id: projectId,
      name: parsed.name ?? (path.basename(rootPath) || rootPath),
      rootPath,
      description: parsed.description ?? null,
      isGitRepository,
      defaultWorkspaceId: workspace.id,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    this.db.driver.transaction(() => {
      // Insert project without the FK-dependent pointer first, then the workspace.
      this.db.projects.insert({ ...project, defaultWorkspaceId: null });
      this.db.workspaces.insert(workspace);
      this.db.projects.update(project);
      this.db.audit.appendSync({
        actor: { type: 'user' },
        action: 'project.registered',
        permission: null,
        projectId,
        target: rootPath,
        outcome: 'success',
        details: { isGitRepository },
        correlationId: null,
      });
    });
    return project;
  }

  async update(input: UpdateProjectInput): Promise<Project> {
    const parsed = parseOrThrow(UpdateProjectInputSchema, input);
    const current = await this.get(parsed.id);
    const next: Project = {
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      updatedAt: nowTimestamp(),
    };
    this.db.driver.transaction(() => {
      this.db.projects.update(next);
      this.db.audit.appendSync({
        actor: { type: 'user' },
        action: 'project.updated',
        permission: null,
        projectId: next.id,
        target: null,
        outcome: 'success',
        details: { fields: Object.keys(parsed).filter((k) => k !== 'id') },
        correlationId: null,
      });
    });
    return next;
  }

  async archive(id: string): Promise<Project> {
    const current = await this.get(id);
    if (current.archivedAt) return current;
    const now = nowTimestamp();
    const next: Project = { ...current, archivedAt: now, updatedAt: now };
    this.db.driver.transaction(() => {
      this.db.projects.update(next);
      this.db.audit.appendSync({
        actor: { type: 'user' },
        action: 'project.archived',
        permission: null,
        projectId: id,
        target: null,
        outcome: 'success',
        details: {},
        correlationId: null,
      });
    });
    return next;
  }

  async listWorkspaces(projectId: string): Promise<Workspace[]> {
    return this.db.workspaces.listByProject(projectId);
  }
}
