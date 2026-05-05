// =============================================================================
// breach-singleton.ts — Process-scoped BreachSupport singleton for Cursor
//
// Cursor hooks run in the same long-lived process. Each hook module previously
// had its own module-scoped `let breachSupport` variable, creating separate
// instances that couldn't share state (blocked actions, approval records, counters).
//
// This module provides a single shared instance across all hook modules.
// =============================================================================

import { BreachSupport } from './breach-support';

let _instance: BreachSupport | null = null;
let _agentId: string = '';

/**
 * Get the process-scoped BreachSupport singleton.
 * Creates a new instance if agentId changes (should not happen within a session).
 */
export function getBreachSupport(agentId: string): BreachSupport {
  if (!_instance || _agentId !== agentId) {
    _instance = new BreachSupport(agentId);
    _agentId = agentId;
  }
  return _instance;
}
