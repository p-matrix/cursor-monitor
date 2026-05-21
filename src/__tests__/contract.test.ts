// =============================================================================
// cursor-monitor contract.test.ts — Tier 2 conformance (Contract v0.1)
// =============================================================================
// Cursor is the only IDE adapter in our 6 SDK (others are CLI).
// host_surface: 'ide' validates that core-sdk schema accepts non-CLI surfaces.
// =============================================================================

import {
  AgentEventSchema,
  NormalizedActionEventSchema,
  ObservableFactSchema,
  AxisEvidenceSchema,
  PEPEvaluationInputSchema,
  type AgentEvent,
  type NormalizedActionEvent,
  type ObservableFact,
  type AxisEvidence,
  type PEPEvaluationInput,
} from '@pmatrix/core-sdk';
import { PMatrixHttpClient } from '../client';
import type { SessionSummaryInput } from '../client';
import type { PMatrixConfig } from '@pmatrix/core-sdk';

function mockConfig(): PMatrixConfig {
  return {
    serverUrl: 'https://test.invalid',
    agentId: 'cursor-agent-001',
    apiKey: 'test-key',
    safetyGate: { enabled: true, serverTimeoutMs: 2500 },
    credentialProtection: { enabled: true, customPatterns: [] },
    killSwitch: { autoHaltOnRt: 0.75 },
    dataSharing: false,
    batch: { maxSize: 50, flushIntervalMs: 5000, retryMax: 3 },
    debug: false,
  };
}

function cursorAgentEvent(eventType: string, hookName: string): AgentEvent {
  return {
    vendor: 'cursor',
    product: 'cursor-ide',
    host_surface: 'ide',  // ← IDE, not CLI
    event_type: eventType,
    timestamp: '2026-05-20T00:00:00.000Z',
    session_id: 'sess-cursor-001',
    agent_id: 'cursor-agent-001',
    raw_event_ref: 'sha256:cursor-raw-event',
    content_included: false,
    host_integration_scope: {
      integration_type: 'ide-extension',  // ← IDE-specific
      hook_name: hookName,
      adapter_version: '0.6.0',
    },
    vendor_extensions: { workspace_id: 'ws-001' },
  };
}

describe('cursor-monitor contract v0.1 conformance', () => {
  test('PMatrixHttpClient identity auto-injected (cursor_hook / cursor)', () => {
    const client = new PMatrixHttpClient(mockConfig());
    expect(client.identity.signalSource).toBe('cursor_hook');
    expect(client.identity.framework).toBe('cursor');
  });

  test('host_surface=ide accepted (IDE extension, not CLI)', () => {
    const ev = cursorAgentEvent('SessionStart', 'SessionStart');
    expect(ev.host_surface).toBe('ide');
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('SessionSummaryInput drops hardcoded brand fields (R-X.3)', () => {
    const summary: SessionSummaryInput = {
      sessionId: 'sess-001',
      agentId: 'cursor-agent-001',
      totalTurns: 5,
      dangerEvents: 0,
      credentialBlocks: 0,
      safetyGateBlocks: 0,
      framework_tag: 'stable',
    };
    expect(Object.prototype.hasOwnProperty.call(summary, 'signal_source')).toBe(false);
  });

  test.each([
    ['SessionStart', 'SessionStart'],
    ['UserPromptSubmit', 'UserPromptSubmit'],
    ['PreToolUse', 'PreToolUse'],
    ['PostToolUse', 'PostToolUse'],
    ['BeforeReadFile', 'BeforeReadFile'],
    ['AfterFileEdit', 'AfterFileEdit'],
    ['Stop', 'Stop'],
  ])('emits valid AgentEvent for %s hook', (eventType, hookName) => {
    const ev = cursorAgentEvent(eventType, hookName);
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('vendor_extensions accepts Cursor primitives', () => {
    const ev = cursorAgentEvent('AfterFileEdit', 'AfterFileEdit');
    ev.vendor_extensions = {
      workspace_id: 'ws-001',
      file_path: '/repo/src/main.ts',
      in_scope: null, // R-X.3 nullable in_scope (cursor BreachSupport pattern)
      action_primitive: 'AP-2',
      duration_ms: 250,
    };
    expect(AgentEventSchema.safeParse(ev).success).toBe(true);
  });

  test('5-layer round-trip — file_write', () => {
    const agentEvent: AgentEvent = cursorAgentEvent('AfterFileEdit', 'AfterFileEdit');
    expect(AgentEventSchema.safeParse(agentEvent).success).toBe(true);

    const normalized: NormalizedActionEvent = {
      source_event_ref: agentEvent.raw_event_ref,
      action_type: 'file_write',
      actor: agentEvent.agent_id,
      target: '/repo/src/main.ts',
      scope: {},
      action_category: 'fs-write',
      evidence_ref: 'sha256:file-write-evidence',
    };
    expect(NormalizedActionEventSchema.safeParse(normalized).success).toBe(true);

    const fact: ObservableFact = {
      fact_type: 'action',
      fact_id: 'fact-cursor-001',
      agent_id: agentEvent.agent_id,
      contract_id: 'contract-cursor-001',
      source_vendor: agentEvent.vendor,
      source_surface: 'ide',  // ← IDE source
      observed_at: agentEvent.timestamp,
      confidence: 0.9,
      provenance: {
        adapter_id: 'cursor-monitor-001',
        adapter_version: '0.6.0',
        chain_ref: null,
        signature: 'hmac-sha256:cursor-sig',
      },
      content_agnostic_ref: 'sha256:fact-canonical',
    };
    expect(ObservableFactSchema.safeParse(fact).success).toBe(true);

    const evidence: AxisEvidence = {
      axis: 'norm',
      evidence_type: 'observation',
      signal_strength: 0.15,
      direction: 'neutral',
      confidence: 0.9,
      reason_code: 'in_scope_file_modification',
      fact_refs: [fact.fact_id],
      axis_status: 'PASS',
    };
    expect(AxisEvidenceSchema.safeParse(evidence).success).toBe(true);

    const pepInput: PEPEvaluationInput = {
      delegation_contract_ref: null,
      current_runtime_mode: 'Normal',
      current_rt: 0.18,
      current_tier: 'T5',
      action_type: 'file_write',
      action_category: 'fs-write',
      authority_scope: 'workspace_write',
      approval_requirement: 'auto',
      risk_level: 'medium',
      fact_refs: [fact.fact_id],
      peer_verifications: [
        {
          peer_node_id: 'peer-cursor-verifier',
          decision: 'PASS',
          axes_status: {
            cap_within_bounds: 'N/A',
            delegation_receipt_valid: 'N/A',
            expiry_not_passed: 'N/A',
            action_within_scope: 'PASS',
            delegator_authority: 'PASS',
            policy_digest_match: 'PASS',
            rt_within_threshold: 'PASS',
            mode_compatible: 'PASS',
          },
          signature: 'hmac-sha256:peer-cursor',
          timestamp: agentEvent.timestamp,
        },
      ],
      quorum_rule: 'critical-axis-veto',
    };
    expect(PEPEvaluationInputSchema.safeParse(pepInput).success).toBe(true);
  });
});
