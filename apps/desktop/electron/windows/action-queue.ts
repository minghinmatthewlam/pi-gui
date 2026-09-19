export class SerializedActionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
