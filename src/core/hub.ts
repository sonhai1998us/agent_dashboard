import type { HubEvent } from './model';

export class Hub {
  private subs = new Set<(e: HubEvent) => void>();

  publish(e: HubEvent): void {
    for (const fn of [...this.subs]) {
      try {
        fn(e);
      } catch {
        // a failing subscriber must not break the others
      }
    }
  }

  subscribe(fn: (e: HubEvent) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }
}
