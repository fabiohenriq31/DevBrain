import { realpath as realpathCb } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CreateProjectInputSchema,
  DevBrainError,
  ListProjectsInputSchema,
  ProjectSettingsPatchSchema,
  RegisterProjectInputSchema,
  RemoveProjectInputSchema,
  UpdateProjectInputSchema,
  UpdateWorkspaceAccessInputSchema,
  newId,
  nowTimestamp,
  parseOrThrow,
  type CreateProjectInput,
  type ListProjectsInput,
  type Project,
  type ProjectService,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type RegisterProjectInput,
  type RemoveProjectInput,
  type UpdateProjectInput,
  type UpdateWorkspaceAccessInput,
  type Workspace,
} from '@devbrain/contracts';
import type { DevBrainDatabase } from '@devbrain/database';
import { assertSafePathSyntax, isWithinRoot } from '@devbrain/security';
import { detectTechnologies } from './technologies.js';

const realpathNative = promisify(realpathCb.native);

export interface ProjectServiceOptions {
  /**
   * Directories that must never become (or contain) an authorized root — e.g. DevBrain's own
   * userData (database, credentials, logs).
   */
  protectedPaths?: readonly string[];
  /** Called after any change (used to emit `projects.changed`). */
  onChanged?: (projectId: string) => void;
}

const systemRoots = (): string[] =>
  [
    process.env['SystemRoot'],
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramData'],
  ].filter((p): p is string => Boolean(p));

const isDirectory = async (p: string): Promise<boolean> => {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
};

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Validates a user-supplied directory and returns its canonical real path (symlinks and
 * junctions resolved, Windows casing normalized).
 */
export const normalizeDirectory = async (input: string): Promise<string> => {
  assertSafePathSyntax(input);
  if (!path.isAbsolute(input))
    throw new DevBrainError('VALIDATION_FAILED', 'Path must be absolute');
  const resolved = path.resolve(input);
  let real: string;
  try {
    real = await realpathNative(resolved);
  } catch {
    throw new DevBrainError('NOT_FOUND', 'Directory does not exist', {
      details: { path: resolved },
    });
  }
  if (!(await isDirectory(real)))
    throw new DevBrainError('VALIDATION_FAILED', 'Path is not a directory');
  return real;
};

export class LocalProjectService implements ProjectService {
  private readonly protectedPaths: readonly string[];

  constructor(
    private readonly db: DevBrainDatabase,
    private readonly options: ProjectServiceOptions = {},
  ) {
    this.protectedPaths = options.protectedPaths ?? [];
  }

  // ------------------------------------------------------------------ helpers

  private audit(
    action: string,
    projectId: string | null,
    target: string | null,
    details: Record<string, unknown> = {},
  ): void {
    this.db.audit.appendSync({
      actor: { type: 'user' },
      action,
      permission: null,
      projectId,
      target,
      outcome: 'success',
      details,
      correlationId: null,
    });
  }

  private changed(projectId: string): void {
    this.options.onChanged?.(projectId);
  }

  /** Rejects roots that are drives, contain the user profile, system folders or private data. */
  assertAllowedRoot(real: string): void {
    const deny = (why: string): never => {
      throw new DevBrainError('PERMISSION_DENIED', `This directory cannot be authorized: ${why}`, {
        details: { path: real },
      });
    };
    if (real === path.parse(real).root) deny('filesystem root');
    const home = process.env['USERPROFILE'] ?? process.env['HOME'];
    if (home && isWithinRoot(real, home)) deny('it contains the user profile');
    for (const sys of systemRoots()) if (isWithinRoot(sys, real)) deny('system directory');
    for (const p of this.protectedPaths) {
      if (isWithinRoot(p, real) || isWithinRoot(real, p)) deny('DevBrain private data');
    }
  }

  private requireProject(id: string): Project {
    const project = this.db.projects.findById(id);
    if (!project) throw new DevBrainError('NOT_FOUND', 'Project not found', { details: { id } });
    return project;
  }

  private defaultSettings(projectId: string): ProjectSettings {
    return {
      projectId,
      preferredAgentId: null,
      permissionPolicyId: null,
      providerPreferences: [],
      excludedPaths: [],
      notes: null,
      updatedAt: nowTimestamp(),
    };
  }

  // ------------------------------------------------------------------ queries

  async list(input: ListProjectsInput = {}): Promise<Project[]> {
    const { includeArchived } = parseOrThrow(ListProjectsInputSchema, input);
    return this.db.projects.list(includeArchived);
  }

  async get(id: string): Promise<Project> {
    return this.requireProject(id);
  }

  async listRecent(limit = 10): Promise<Project[]> {
    return this.db.projects.listRecent(Math.min(Math.max(1, limit), 50));
  }

  async listWorkspaces(projectId: string): Promise<Workspace[]> {
    this.requireProject(projectId);
    return this.db.workspaces.listByProject(projectId);
  }

  async getSettings(projectId: string): Promise<ProjectSettings> {
    this.requireProject(projectId);
    return this.db.projectSettings.get(projectId) ?? this.defaultSettings(projectId);
  }

  // ------------------------------------------------------------------ commands

  /** Imports an existing directory (Git or not). */
  async register(input: RegisterProjectInput): Promise<Project> {
    const parsed = parseOrThrow(RegisterProjectInputSchema, input);
    const rootPath = await normalizeDirectory(parsed.rootPath);
    this.assertAllowedRoot(rootPath);
    if (this.db.projects.findByRootPath(rootPath)) {
      throw new DevBrainError(
        'ALREADY_EXISTS',
        'A project is already registered for this directory',
      );
    }
    for (const other of this.db.projects.list(true)) {
      if (isWithinRoot(other.rootPath, rootPath) || isWithinRoot(rootPath, other.rootPath)) {
        throw new DevBrainError('CONFLICT', 'Directory overlaps an already registered project', {
          details: { projectId: other.id },
        });
      }
    }

    const isGitRepository = await exists(path.join(rootPath, '.git'));
    const technologies = await detectTechnologies(rootPath);
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
      technologies,
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };

    this.db.driver.transaction(() => {
      this.db.projects.insert({ ...project, defaultWorkspaceId: null });
      this.db.workspaces.insert(workspace);
      this.db.projects.update(project);
      this.db.projectSettings.save(this.defaultSettings(projectId));
      this.audit('project.registered', projectId, rootPath, {
        isGitRepository,
        technologies: technologies.map((t) => t.id),
      });
    });
    this.changed(projectId);
    return project;
  }

  /** Creates a new empty folder under an existing parent and registers it. */
  async create(input: CreateProjectInput): Promise<Project> {
    const parsed = parseOrThrow(CreateProjectInputSchema, input);
    const parent = await normalizeDirectory(parsed.parentPath);
    const target = path.join(parent, parsed.folderName);
    if (path.dirname(target) !== parent)
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid folder name');
    this.assertAllowedRoot(target);
    if (await exists(target)) {
      const entries = await readdir(target).catch(() => null);
      if (entries === null || entries.length > 0) {
        throw new DevBrainError('ALREADY_EXISTS', 'Target folder already exists and is not empty');
      }
    } else {
      await mkdir(target);
    }
    return this.register({
      rootPath: target,
      name: parsed.name ?? parsed.folderName,
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    });
  }

  async update(input: UpdateProjectInput): Promise<Project> {
    const parsed = parseOrThrow(UpdateProjectInputSchema, input);
    const current = this.requireProject(parsed.id);
    const next: Project = {
      ...current,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      updatedAt: nowTimestamp(),
    };
    this.db.driver.transaction(() => {
      this.db.projects.update(next);
      this.audit('project.updated', next.id, null, {
        fields: Object.keys(parsed).filter((k) => k !== 'id'),
      });
    });
    this.changed(next.id);
    return next;
  }

  async archive(id: string): Promise<Project> {
    const current = this.requireProject(id);
    if (current.archivedAt) return current;
    const now = nowTimestamp();
    const next: Project = { ...current, archivedAt: now, updatedAt: now };
    this.db.driver.transaction(() => {
      this.db.projects.update(next);
      this.audit('project.archived', id, null);
    });
    this.changed(id);
    return next;
  }

  async restore(id: string): Promise<Project> {
    const current = this.requireProject(id);
    if (!current.archivedAt) return current;
    const next: Project = { ...current, archivedAt: null, updatedAt: nowTimestamp() };
    this.db.driver.transaction(() => {
      this.db.projects.update(next);
      this.audit('project.restored', id, null);
    });
    this.changed(id);
    return next;
  }

  /**
   * Removes the registration and its DevBrain history (cascade). Files on disk are never
   * touched. Refused while the project has live sessions.
   */
  async remove(input: RemoveProjectInput): Promise<void> {
    const parsed = parseOrThrow(RemoveProjectInputSchema, input);
    const project = this.requireProject(parsed.id);
    const live = this.db.sessions.list({
      projectId: project.id,
      status: ['starting', 'active', 'idle'],
      limit: 1,
    });
    if (live.length > 0) {
      throw new DevBrainError(
        'CONFLICT',
        'Stop the active sessions of this project before removing it',
      );
    }
    this.db.driver.transaction(() => {
      this.db.projects.delete(project.id);
      this.audit('project.removed', project.id, project.rootPath, { filesDeleted: false });
    });
    this.changed(project.id);
  }

  async markOpened(id: string): Promise<Project> {
    const current = this.requireProject(id);
    const next: Project = { ...current, lastOpenedAt: nowTimestamp() };
    this.db.projects.update(next);
    return next;
  }

  async refreshTechnologies(id: string): Promise<Project> {
    const current = this.requireProject(id);
    const [technologies, isGitRepository] = await Promise.all([
      detectTechnologies(current.rootPath),
      exists(path.join(current.rootPath, '.git')),
    ]);
    const next: Project = { ...current, technologies, isGitRepository, updatedAt: nowTimestamp() };
    this.db.projects.update(next);
    this.changed(id);
    return next;
  }

  async updateSettings(patch: ProjectSettingsPatch): Promise<ProjectSettings> {
    const parsed = parseOrThrow(ProjectSettingsPatchSchema, patch);
    const current = await this.getSettings(parsed.projectId);
    if (parsed.preferredAgentId && !this.db.agents.findById(parsed.preferredAgentId)) {
      throw new DevBrainError('NOT_FOUND', 'Agent not found');
    }
    if (parsed.permissionPolicyId && !this.db.policies.findById(parsed.permissionPolicyId)) {
      throw new DevBrainError('NOT_FOUND', 'Permission policy not found');
    }
    for (const pref of parsed.providerPreferences ?? []) {
      if (!this.db.providers.findById(pref.providerId)) {
        throw new DevBrainError('NOT_FOUND', 'Provider not found', {
          details: { id: pref.providerId },
        });
      }
    }
    const next: ProjectSettings = {
      ...current,
      ...(parsed.preferredAgentId !== undefined
        ? { preferredAgentId: parsed.preferredAgentId }
        : {}),
      ...(parsed.permissionPolicyId !== undefined
        ? { permissionPolicyId: parsed.permissionPolicyId }
        : {}),
      ...(parsed.providerPreferences !== undefined
        ? { providerPreferences: parsed.providerPreferences }
        : {}),
      ...(parsed.excludedPaths !== undefined ? { excludedPaths: parsed.excludedPaths } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      updatedAt: nowTimestamp(),
    };
    this.db.driver.transaction(() => {
      this.db.projectSettings.save(next);
      this.audit('project.settings-updated', parsed.projectId, null, {
        fields: Object.keys(parsed).filter((k) => k !== 'projectId'),
      });
    });
    this.changed(parsed.projectId);
    return next;
  }

  /** Changes the authorized directories of a workspace. */
  async updateWorkspaceAccess(input: UpdateWorkspaceAccessInput): Promise<Workspace> {
    const parsed = parseOrThrow(UpdateWorkspaceAccessInputSchema, input);
    const workspace = this.db.workspaces.findById(parsed.workspaceId);
    if (!workspace) throw new DevBrainError('NOT_FOUND', 'Workspace not found');
    const allowed = await Promise.all(parsed.allowedRoots.map(normalizeDirectory));
    const readOnly = await Promise.all(parsed.readOnlyRoots.map(normalizeDirectory));
    const sameAsRoot = (r: string) =>
      isWithinRoot(r, workspace.rootPath) && isWithinRoot(workspace.rootPath, r);
    if (!allowed.some(sameAsRoot)) {
      throw new DevBrainError(
        'VALIDATION_FAILED',
        'Authorized directories must include the workspace root',
      );
    }
    allowed.forEach((r) => this.assertAllowedRoot(r));
    for (const r of readOnly) {
      if (!allowed.some((a) => isWithinRoot(a, r))) {
        throw new DevBrainError(
          'VALIDATION_FAILED',
          'Read-only directories must be inside authorized ones',
        );
      }
    }
    const next: Workspace = {
      ...workspace,
      access: {
        allowedRoots: [...new Set(allowed)],
        readOnlyRoots: [...new Set(readOnly)],
        allowNetwork: parsed.allowNetwork,
      },
      updatedAt: nowTimestamp(),
    };
    this.db.driver.transaction(() => {
      this.db.workspaces.update(next);
      this.audit('workspace.access-updated', workspace.projectId, workspace.rootPath, {
        allowedRoots: next.access.allowedRoots,
        readOnlyRoots: next.access.readOnlyRoots,
        allowNetwork: next.access.allowNetwork,
      });
    });
    this.changed(workspace.projectId);
    return next;
  }
}
