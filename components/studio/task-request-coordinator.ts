export type TaskLoadMode = "replace" | "append";

export class TaskRequestCoordinator {
  private sequence = 0;
  private activeToken: number | null = null;
  private pendingReplace = false;

  begin(mode: TaskLoadMode): number | null {
    if (this.activeToken !== null) {
      if (mode === "replace") this.pendingReplace = true;
      return null;
    }
    const token = ++this.sequence;
    this.activeToken = token;
    return token;
  }

  isCurrent(token: number): boolean {
    return this.activeToken === token;
  }

  finish(token: number): boolean {
    if (this.activeToken !== token) return false;
    this.activeToken = null;
    const replay = this.pendingReplace;
    this.pendingReplace = false;
    return replay;
  }

  cancel(): void {
    this.sequence += 1;
    this.activeToken = null;
    this.pendingReplace = false;
  }
}
