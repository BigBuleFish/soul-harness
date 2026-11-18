/**
 * Test-only fault injection for the read guard.
 *
 * Not exported from `src/index.ts`: the published surface stays free of test
 * switches, while tests import this module directly and force a deterministic
 * failure at a specific guard stage. Production keeps the hook at `null`, so the
 * call costs one comparison.
 */

export type ReadGuardStage = 'enable' | 'restore';

type ReadGuardFault = (stage: ReadGuardStage) => Error | null;

let faultForTests: ReadGuardFault | null = null;

/** Installs a fault for the current test file; pass `null` to restore normal behaviour. */
export function setReadGuardFaultForTests(fault: ReadGuardFault | null): void {
  faultForTests = fault;
}

/** @internal Returns the injected error for `stage`, or null when no fault is armed. */
export function takeReadGuardFault(stage: ReadGuardStage): Error | null {
  return faultForTests === null ? null : faultForTests(stage);
}
