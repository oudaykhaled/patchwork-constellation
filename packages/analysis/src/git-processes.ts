import type { ChildProcess } from 'node:child_process';

/**
 * Receives the id of every Git process started in this thread, and its exit.
 *
 * A worker thread reports these to its launcher. Terminating a worker does not stop the
 * processes it started, so the launcher can stop any that a cancelled task left behind.
 */
export interface GitProcessObserver { spawned(pid: number): void; exited(pid: number): void; }
const observers = new Set<GitProcessObserver>();

export function observeGitProcesses(observer: GitProcessObserver): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/** Called by every Git spawn site in this package. */
export function trackGitProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || !observers.size) return;
  for (const observer of observers) observer.spawned(pid);
  child.once('exit', () => { for (const observer of observers) observer.exited(pid); });
}
