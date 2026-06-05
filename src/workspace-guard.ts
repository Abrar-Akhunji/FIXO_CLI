import fs from 'fs';
import path from 'path';

export class WorkspaceGuard {
  readonly root: string;
  private allowList: string[];

  constructor(root: string, allowList: string[] = []) {
    try {
      this.root = fs.realpathSync(path.resolve(root));
    } catch {
      this.root = path.resolve(root);
    }
    this.allowList = allowList;
  }

  private safeRealPath(p: string): string {
    try {
      return fs.realpathSync(p);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(p);
        if (parent === p) return p;
        return path.join(this.safeRealPath(parent), path.basename(p));
      }
      throw err;
    }
  }

  resolve(input: string | undefined, label = 'path'): string {
    const raw = input?.trim() || '.';
    const resolved = path.resolve(this.root, raw);
    if (!this.isInside(resolved)) {
      throw new Error(`${label} escapes workspace: ${input ?? '.'}`);
    }
    return resolved;
  }

  isInside(target: string): boolean {
    const resolvedTarget = this.safeRealPath(path.resolve(target));
    const relative = path.relative(this.root, resolvedTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  relative(target: string): string {
    return path.relative(this.root, path.resolve(target)) || '.';
  }

  ensureFile(target: string): string {
    const resolved = this.resolve(target, 'file');
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${target}`);
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`File does not exist: ${target}`);
      }
      throw err;
    }
    return resolved;
  }

  isBinaryFile(target: string, sampleBytes = 4096): boolean {
    const fd = fs.openSync(target, 'r');
    try {
      const buffer = Buffer.alloc(sampleBytes);
      const bytesRead = fs.readSync(fd, buffer, 0, sampleBytes, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  }
}

