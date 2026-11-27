import type { PermissionAction, PermissionDecision } from '@devbrain/contracts';

/**
 * Command execution control. Commands are always `executable + args` spawned WITHOUT a
 * shell (`shell: false`). This module classifies a command so the execution engine can
 * map it to permission actions and decide whether human approval is needed.
 */

export interface CommandSpec {
  executable: string;
  args: readonly string[];
}

export interface CommandAssessment {
  /** Permission actions this command implies (always includes `process.spawn`). */
  actions: PermissionAction[];
  /** Hard floor imposed by the classifier, combined with the agent policy by the caller. */
  decision: PermissionDecision;
  reasons: string[];
}

const baseName = (executable: string): string =>
  (executable.split(/[\\/]/).pop() ?? executable)
    .replace(/\.(exe|cmd|bat|com)$/i, '')
    .toLowerCase();

/** Interpreters / shells that can run arbitrary code passed as arguments. */
const SHELLS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'wsl',
  'wscript',
  'cscript',
  'mshta',
]);
const ELEVATION = new Set(['sudo', 'runas', 'gsudo', 'doas', 'su']);
const ALWAYS_DENY = new Set([
  'format',
  'diskpart',
  'bcdedit',
  'reg',
  'vssadmin',
  'cipher',
  'takeown',
  'icacls',
]);
const DELETERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'shred']);
const PACKAGE_MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'uv',
  'cargo',
  'go',
  'winget',
  'choco',
  'scoop',
]);
const NETWORK = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
  'ssh',
  'scp',
  'ftp',
  'nc',
  'ncat',
]);
const INSTALL_VERBS = new Set(['install', 'i', 'add', 'update', 'upgrade', 'get']);
const PUBLISH_VERBS = new Set(['publish', 'deploy', 'release']);

/** Characters that only make sense to a shell; with `shell: false` they indicate injection attempts. */
const SHELL_METACHARS = /[`$|;&<>]|\$\(|&&|\|\|/;

const hasFlag = (args: readonly string[], ...flags: string[]): boolean =>
  args.some(
    (a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)),
  );

const gitActions = (
  args: readonly string[],
): { actions: PermissionAction[]; reasons: string[] } => {
  const sub = args.find((a) => !a.startsWith('-'));
  const actions: PermissionAction[] = [];
  const reasons: string[] = [];
  switch (sub) {
    case 'push':
      if (
        hasFlag(args, '--force', '-f', '--force-with-lease', '--mirror') ||
        args.some((a) => a.startsWith('+'))
      ) {
        actions.push('git.force-push');
        reasons.push('force push');
      } else {
        actions.push('git.push');
      }
      if (hasFlag(args, '--delete', '-d')) actions.push('git.branch-delete');
      break;
    case 'commit':
      actions.push('git.commit');
      if (hasFlag(args, '--amend')) actions.push('git.history-rewrite');
      break;
    case 'branch':
      if (hasFlag(args, '-d', '-D', '--delete')) actions.push('git.branch-delete');
      break;
    case 'reset':
      if (hasFlag(args, '--hard')) {
        actions.push('fs.delete');
        reasons.push('git reset --hard discards changes');
      }
      break;
    case 'clean':
      actions.push('fs.delete');
      break;
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
      actions.push('git.history-rewrite');
      break;
    case 'checkout':
    case 'restore':
      if (args.includes('--') || hasFlag(args, '--force', '-f')) actions.push('fs.delete');
      break;
    case 'clone':
    case 'fetch':
    case 'pull':
      actions.push('network.request');
      break;
    default:
      break;
  }
  return { actions, reasons };
};

export const assessCommand = (spec: CommandSpec): CommandAssessment => {
  const name = baseName(spec.executable);
  const actions = new Set<PermissionAction>(['process.spawn']);
  const reasons: string[] = [];
  let decision: PermissionDecision = 'allow';
  const raise = (d: PermissionDecision, reason: string) => {
    if (d === 'deny' || (d === 'ask' && decision === 'allow')) decision = d;
    reasons.push(reason);
  };

  if (ALWAYS_DENY.has(name)) raise('deny', `${name} is never allowed for agents`);
  if (ELEVATION.has(name)) {
    actions.add('privilege.elevate');
    raise('ask', 'privilege elevation');
  }
  if (SHELLS.has(name)) raise('ask', `${name} can execute arbitrary code`);
  if (DELETERS.has(name)) {
    actions.add('fs.delete');
    raise('ask', 'deletes files');
  }
  if (NETWORK.has(name)) actions.add('network.request');
  if (name === 'git') {
    const git = gitActions(spec.args);
    git.actions.forEach((a) => actions.add(a));
    git.reasons.forEach((r) => reasons.push(r));
  }
  const verb = spec.args.find((a) => !a.startsWith('-'))?.toLowerCase();
  if (PACKAGE_MANAGERS.has(name) && verb && INSTALL_VERBS.has(verb)) {
    actions.add('package.install');
    actions.add('network.request');
  }
  if (
    verb &&
    PUBLISH_VERBS.has(verb) &&
    (PACKAGE_MANAGERS.has(name) || ['gh', 'vercel', 'netlify', 'docker'].includes(name))
  ) {
    actions.add('external.publish');
    raise('ask', 'publishes externally');
  }
  if (name === 'gh' && ['release', 'pr', 'repo'].includes(verb ?? ''))
    actions.add('external.publish');
  if (spec.args.some((a) => SHELL_METACHARS.test(a)) && SHELLS.has(name)) {
    raise('ask', 'shell metacharacters passed to an interpreter');
  }
  if (/[\0\r\n]/.test(spec.executable)) raise('deny', 'invalid executable');
  return { actions: [...actions], decision, reasons };
};
