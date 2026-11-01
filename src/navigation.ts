export interface NavigationEvent {
  session: number;
  id: string;
  phase: 'started' | 'finished' | 'cancelled' | 'failed';
}

export class NavigationTracker {
  private session = 0;
  private current: string | null = null;
  private cancelled = new Set<string>();

  reset(session: number): void {
    this.session = session;
    this.current = null;
    this.cancelled.clear();
  }

  cancel(): void {
    if (this.current) this.cancelled.add(this.current);
    this.current = null;
  }

  accept(event: NavigationEvent): boolean {
    if (event.session !== this.session || this.cancelled.has(event.id)) return false;
    if (event.phase === 'started') {
      if (this.current && this.current !== event.id) this.cancelled.add(this.current);
      this.current = event.id;
    }
    return this.current === event.id;
  }
}
