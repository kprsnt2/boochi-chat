/**
 * Wire contracts shared by the browser and the server.
 * Keep this file dependency-free: it is imported by both bundles.
 */

export type Role = "owner" | "guest";

/** "paid" tiers use *_API_KEY_PAID keys (no-training terms). "free" tiers use plain *_API_KEY keys. */
export type TierKind = "paid" | "free";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; name?: string }
  /**
   * A PDF. `data` is sent to models that read PDFs natively (Gemini);
   * `text` (extracted in the browser) is sent to everything else.
   */
  | { type: "pdf"; name: string; data?: string; text?: string };

export interface WireMessage {
  role: "user" | "assistant";
  parts: ContentPart[];
}

export interface ChatRequest {
  agentId: string;
  /** Private = paid, no-training keys only. Ignored (forced false) for guests. */
  private: boolean;
  /** Optional "kind:provider:model" pin from the model picker. Validated server-side. */
  model?: string | null;
  messages: WireMessage[];
  /** System prompt of a custom (locally defined) agent. Owners only. */
  customPrompt?: string | null;
}

export interface Attempt {
  provider: string;
  model: string;
  tier: TierKind;
  ok: boolean;
  ms: number;
  error?: string;
  /** Set when this attempt was an automatic continuation of a cut-off answer. */
  continuation?: boolean;
}

export interface ServedBy {
  provider: string;
  model: string;
  label: string;
  tier: TierKind;
}

/** Newline-delimited JSON events streamed from POST /api/chat. */
export type StreamEvent =
  /** First event: whether the server actually routed this privately. */
  | { type: "mode"; private: boolean }
  | { type: "start"; servedBy: ServedBy }
  | { type: "delta"; text: string }
  | { type: "notice"; text: string }
  /** `incomplete` = the answer is still unfinished (press Continue). */
  | { type: "done"; servedBy: ServedBy; attempts: Attempt[]; continued: number; incomplete: boolean }
  | { type: "error"; message: string; attempts: Attempt[] };

export interface TierInfo {
  id: string; // "kind:provider:model"
  provider: string;
  model: string;
  label: string;
  tier: TierKind;
  configured: boolean;
  vision: boolean;
  pdfNative: boolean;
}

export interface PublicConfig {
  /** Display name (APP_NAME env). */
  appName: string;
  role: Role | null; // null = not signed in and guests disabled
  email: string | null;
  guestEnabled: boolean;
  /** True when the server can actually send OTP e-mails. */
  emailLoginEnabled: boolean;
  /** Tiers this identity may use. Guests only ever see free tiers. */
  paid: TierInfo[];
  free: TierInfo[];
  limits: { maxRequestMB: number };
}

/** Sent (as a user turn) to resume an answer that was cut off. */
export const CONTINUE_PROMPT =
  "Your previous reply was cut off. Continue EXACTLY from the last character you wrote. " +
  "Do not repeat any earlier text, do not add a preamble, and do not restart the list or section.";
