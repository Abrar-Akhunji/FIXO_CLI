import path from "path";

export interface LockState {
  agentId: string;
  type: "read" | "write";
}

export class WorkspaceLockManager {
  private locks = new Map<string, LockState[]>();

  /**
   * Tries to acquire a lock on a file.
   * Returns true if successful, false if the lock is held by another agent.
   */
  acquireLock(
    filePath: string,
    agentId: string,
    lockType: "read" | "write",
  ): boolean {
    const normalizedPath = path.resolve(filePath);
    const activeLocks = this.locks.get(normalizedPath) || [];

    if (activeLocks.length === 0) {
      this.locks.set(normalizedPath, [{ agentId, type: lockType }]);
      return true;
    }

    // Check if the current agent already holds a lock of the same or higher type
    const agentLock = activeLocks.find((l) => l.agentId === agentId);
    if (agentLock) {
      if (agentLock.type === lockType || agentLock.type === "write") {
        return true;
      }
      // Upgrade from read to write
      if (lockType === "write") {
        // Can only upgrade if this agent is the ONLY reader
        if (activeLocks.length === 1) {
          agentLock.type = "write";
          return true;
        }
        return false; // Other agents hold read locks, cannot upgrade
      }
    }

    // If any write lock is active, block all new locks
    if (activeLocks.some((l) => l.type === "write")) {
      return false;
    }

    // If new lock is write and there are existing read locks, block it
    if (lockType === "write") {
      return false;
    }

    // Otherwise, add a shared read lock
    activeLocks.push({ agentId, type: lockType });
    this.locks.set(normalizedPath, activeLocks);
    return true;
  }

  /**
   * Releases a lock held by an agent on a file.
   * Returns true if a lock was released, false if no lock existed for this agent.
   */
  releaseLock(filePath: string, agentId: string): boolean {
    const normalizedPath = path.resolve(filePath);
    const activeLocks = this.locks.get(normalizedPath) || [];
    const index = activeLocks.findIndex((l) => l.agentId === agentId);

    if (index === -1) {
      return false;
    }

    activeLocks.splice(index, 1);
    if (activeLocks.length === 0) {
      this.locks.delete(normalizedPath);
    } else {
      this.locks.set(normalizedPath, activeLocks);
    }
    return true;
  }

  /**
   * Releases all locks held by a specific agent.
   */
  releaseAllLocks(agentId: string): void {
    for (const [filePath, activeLocks] of this.locks.entries()) {
      const filtered = activeLocks.filter((l) => l.agentId !== agentId);
      if (filtered.length === 0) {
        this.locks.delete(filePath);
      } else {
        this.locks.set(filePath, filtered);
      }
    }
  }

  /**
   * Checks if a file is currently locked in a way that conflicts with the requested lockType.
   */
  isLocked(filePath: string, lockType: "read" | "write"): boolean {
    const normalizedPath = path.resolve(filePath);
    const activeLocks = this.locks.get(normalizedPath) || [];

    if (activeLocks.length === 0) {
      return false;
    }

    if (lockType === "write") {
      return true; // Any lock (read or write) blocks a new write lock
    }

    // For read locks, only an active write lock blocks it
    return activeLocks.some((l) => l.type === "write");
  }
}

export const workspaceLockManager = new WorkspaceLockManager();
