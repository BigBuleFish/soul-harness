/**
 * In-process Store leases (SH-008D D3, P7/P8).
 *
 * Recovery and Scheduler must not run over the same Store object at the same
 * time. The lease is a `WeakMap<Store, kind>` so it disappears with the handle
 * and never outlives the process. This is process-local coordination only; it
 * says nothing about other processes or other `Store` objects for the same file
 * (SH-007A's single-instance lock covers that).
 */

import type { Store } from '@soul-harness/persistence';

import { RuntimeError } from './errors.js';

export type StoreLeaseKind = 'scheduler' | 'recovery';

const leases = new WeakMap<Store, StoreLeaseKind>();

/**
 * Takes the lease for `kind` or throws `illegal_transition`.
 *
 * Returns an idempotent release function. Both the success and the failure path
 * of the owner must call it — callers use `try/finally`.
 */
export function acquireStoreLease(store: Store, kind: StoreLeaseKind): () => void {
  const held = leases.get(store);
  if (held !== undefined) {
    throw new RuntimeError(
      'illegal_transition',
      held === kind
        ? `a ${kind} already owns this store`
        : `this store is currently owned by ${held}`,
      { details: { held } },
    );
  }

  leases.set(store, kind);
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    if (leases.get(store) === kind) {
      leases.delete(store);
    }
  };
}

/** Test-only visibility; not exported from the package entry point. */
export function hasStoreLease(store: Store): boolean {
  return leases.has(store);
}
