// =============================================================================
// @pmatrix/cursor-monitor — client.ts
// =============================================================================
// R-X.3 migration: PMatrixHttpClient extracted to @pmatrix/core-sdk v0.1.0.
// Thin Cursor-bound wrapper pre-supplying AdapterIdentity (IDE host_surface).
// =============================================================================

import { PMatrixHttpClient as CorePMatrixHttpClient } from '@pmatrix/core-sdk';
import type {
  AdapterIdentity,
  PMatrixConfig,
} from '@pmatrix/core-sdk';

export type { SessionSummaryInput } from '@pmatrix/core-sdk';

const CURSOR_IDENTITY: AdapterIdentity = Object.freeze({
  signalSource: 'cursor_hook',
  framework: 'cursor',
});

export class PMatrixHttpClient extends CorePMatrixHttpClient {
  constructor(config: PMatrixConfig) {
    super(config, CURSOR_IDENTITY);
  }
}
