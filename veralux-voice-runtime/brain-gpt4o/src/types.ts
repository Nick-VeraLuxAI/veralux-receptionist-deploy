/**
 * Request/response types matching the veralux-voice-runtime brain contract.
 */

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface TransferProfile {
  id: string;
  name: string;
  holder?: string;
  responsibilities: string[];
  destination: string;
  audioUrl?: string;
  timeoutSecs?: number;
}

/** Per-tenant context: pricing, products, hours, policies, etc. Keys are section names; values are text. */
export type AssistantContext = Record<string, string>;

export interface BrainReplyRequest {
  tenantId?: string;
  callControlId: string;
  transcript: string;
  history: ConversationTurn[];
  transferProfiles?: TransferProfile[];
  assistantContext?: AssistantContext;
}

export interface BrainTransferAction {
  to: string;
  audioUrl?: string;
  timeoutSecs?: number;
}

export interface BrainReplyResponse {
  text: string;
  transfer?: BrainTransferAction;
}
