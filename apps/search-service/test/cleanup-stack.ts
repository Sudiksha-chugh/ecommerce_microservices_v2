// Attempt every owned scenario cleanup in reverse order, retaining all errors.
export async function closeScenario(cleanup: Array<() => Promise<unknown>>, restoreMocks: () => void) {
 const errors: unknown[] = [];
 for (const close of cleanup.splice(0).reverse()) {
  try { await close(); } catch (error) { errors.push(error); }
 }
 try { restoreMocks(); } catch (error) { errors.push(error); }
 if (errors.length) throw new AggregateError(errors, 'Search scenario cleanup failed');
}
