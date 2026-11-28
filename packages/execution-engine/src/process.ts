import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';

const executableName = (name: string): string =>
  name.toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
const allowedExecutable = (name: string): boolean =>
  !/[\0\r\n]/.test(name) &&
  !['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wscript', 'cscript'].includes(
    executableName(basename(name)),
  );
export const envFor = (names: readonly string[]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of new Set([
    'PATH',
    'Path',
    'PATHEXT',
    'SYSTEMROOT',
    'SystemRoot',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    ...names,
  ])) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
};
export const findExecutable = async (name: string): Promise<string | null> => {
  if (!allowedExecutable(name)) return null;
  const candidates = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .flatMap((dir) =>
          process.platform === 'win32'
            ? [join(dir, name + '.exe'), join(dir, name)]
            : [join(dir, name)],
        );
  for (const candidate of candidates) {
    try {
      if (process.platform === 'win32' && extname(candidate).toLowerCase() !== '.exe') continue;
      if ((await stat(candidate)).isFile()) {
        await access(candidate);
        return await realpath(candidate);
      }
    } catch {
      /* try next PATH entry */
    }
  }
  return null;
};
export const killTree = async (child: ChildProcess, force: boolean): Promise<void> => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { shell: false, windowsHide: true },
    );
    await once(killer, 'exit').catch(() => undefined);
  } else {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
  }
};
