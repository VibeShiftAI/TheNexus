/** Serialize native lifecycle mutations with reconciliation; a failed operation cannot poison the queue. */
export function createPresentationOperationQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
}
