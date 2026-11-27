import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { redactString, redactValue } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void;
  child(component: string): Logger;
}

export interface RotatingLoggerOptions {
  directory: string;
  /** Base name, e.g. `devbrain` → devbrain.log, devbrain.1.log, ... */
  name?: string;
  maxFileBytes: number;
  maxFiles: number;
  minLevel?: LogLevel;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Size-rotated file shared by a logger and its children. */
class RotatingSink {
  private readonly file: string;
  private readonly name: string;
  private size: number;

  constructor(readonly options: RotatingLoggerOptions) {
    mkdirSync(options.directory, { recursive: true });
    this.name = options.name ?? 'devbrain';
    this.file = path.join(options.directory, `${this.name}.log`);
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
  }

  private rotated(index: number): string {
    return path.join(this.options.directory, `${this.name}.${index}.log`);
  }

  private rotate(): void {
    const last = this.options.maxFiles - 1;
    if (last < 1) {
      rmSync(this.file, { force: true });
    } else {
      rmSync(this.rotated(last), { force: true });
      for (let i = last - 1; i >= 1; i -= 1) {
        if (existsSync(this.rotated(i))) renameSync(this.rotated(i), this.rotated(i + 1));
      }
      if (existsSync(this.file)) renameSync(this.file, this.rotated(1));
    }
    this.size = 0;
  }

  write(line: string): void {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.options.maxFileBytes) this.rotate();
    try {
      appendFileSync(this.file, line);
      this.size += bytes;
    } catch {
      // Logging must never crash the app.
    }
  }
}

/**
 * JSON-lines logger with mandatory redaction and size-based rotation, so logs can neither
 * leak secrets nor grow without bound. Synchronous appends keep ordering and survive crashes.
 */
export class RotatingFileLogger implements Logger {
  private readonly sink: RotatingSink;

  constructor(
    options: RotatingLoggerOptions | RotatingSink,
    private readonly component = 'app',
  ) {
    this.sink = options instanceof RotatingSink ? options : new RotatingSink(options);
  }

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.sink.options.minLevel ?? 'info']) return;
    this.sink.write(
      `${JSON.stringify({
        t: new Date().toISOString(),
        level,
        component: this.component,
        message: redactString(message).slice(0, 4000),
        ...(data ? { data: redactValue(data) } : {}),
      })}\n`,
    );
  }

  child(component: string): Logger {
    return new RotatingFileLogger(this.sink, `${this.component}.${component}`);
  }
}

/** Discards everything (tests). */
export const NULL_LOGGER: Logger = { log: () => {}, child: () => NULL_LOGGER };
