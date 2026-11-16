/**
 * Cross-package consumer check — compile half.
 *
 * This file is deliberately NOT part of `packages/contracts`: it exists to prove
 * that another workspace package can consume `@soul-harness/contracts` through
 * its published entry points (package name, not a relative path), and that the
 * emitted `.d.ts` carries the intended types — including the negative ones.
 *
 * It is typechecked by `pnpm run check:consumer`; it is never shipped.
 */

import {
  ERROR_MESSAGES,
  SCHEMAS,
  STIMULUS_INPUT_VERSION,
  isPersonaId,
  type AdapterId,
  type AdapterEventRef,
  type ArchiveAppendResponse,
  type PersonaId,
  type RequestNonce,
  type SourceId,
  type StimulusInputV1,
} from '@soul-harness/contracts';

export const personaId: PersonaId = 'psn_01JQ8Z3K5M7P9R2T4V6X8Z0ABC' as PersonaId;

export const stimulus: StimulusInputV1 = {
  schema: STIMULUS_INPUT_VERSION,
  personaId,
  adapterId: 'minecraft' as AdapterId,
  source: 'minecraft.chat' as SourceId,
  adapterEventRef: 'mc-7f3a9c21' as AdapterEventRef,
  requestNonce: 'NQ7xK2mR9tVb4Wc8' as RequestNonce,
  payload: { kind: 'mc.world', version: 1 },
};

// @ts-expect-error receivedAt is not part of the adapter-submitted envelope
export const stimulusWithReceiptTime: StimulusInputV1 = { ...stimulus, receivedAt: 1 };

// @ts-expect-error archived requires an archiveRef
export const brokenAppendResponse: ArchiveAppendResponse = { result: 'archived' };

export const appendResponse: ArchiveAppendResponse = { result: 'conflict' };

export const schemaCount: number = Object.keys(SCHEMAS).length;
export const canonicalMessage: string = ERROR_MESSAGES.schema_invalid;
export const personaLooksValid: boolean = isPersonaId(personaId);
