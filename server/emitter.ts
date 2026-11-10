/** Minimal typed event emitter, so the desk runs unchanged in Node and in a browser. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly handlers = new Map<keyof Events, Array<(...args: any[]) => void>>();

  on<K extends keyof Events>(event: K, handler: (...args: Events[K]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    const list = this.handlers.get(event);
    if (!list?.length) return false;
    for (const handler of [...list]) handler(...args);
    return true;
  }
}
