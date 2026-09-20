export interface RoutingPreviousExchange {
  user: string;
  assistant: string;
}

export interface RoutingEligibilityInput {
  prompt: string;
  previousExchange?: string | RoutingPreviousExchange;
  /** Actual caller-known facts or a separate completeness decision; never gold labels. */
  essentialFactsAvailable?: boolean;
  /** Ties must be represented as uncertain, never as a fast winner. */
  classification?: {
    decision: "fast" | "strong" | "uncertain";
    confidence?: number;
  };
  artifactQualified?: boolean;
}

export interface RoutingEligibility {
  eligibleForFast: boolean;
  reason: string;
}

export const MINIMUM_FAST_CONFIDENCE = 0.9;

const demandPatterns: readonly [string, RegExp][] = [
  [
    "security-sensitive",
    /\b(?:security|vulnerabilit(?:y|ies)|exploit(?:ation|s)?|penetration|threat\s+model(?:ing)?|cve(?:-\d+)?|csrf|xss|sql\s+injection|cryptograph(?:y|ic))\b/i,
  ],
  [
    "authentication-or-authorization",
    /\b(?:auth(?:entication|orization|enticate|orize)?|oauth|sso|jwt|login|credentials?|secrets?|api[- ]?keys?|access[- ]?tokens?|passwords?|privileges?|permissions?)\b/i,
  ],
  [
    "concurrency-sensitive",
    /\b(?:concurren(?:cy|t)|race(?:[- ]conditions?|s)?|deadlocks?|mutex(?:es)?|semaphores?|locking|thread[- ]safe|atomicity|interleaving|parallelism|synchroniz(?:ation|e))\b/i,
  ],
  [
    "destructive-operation",
    /\b(?:delete|remove|drop|destroy|wipe|erase|purge|truncate|overwrite)\b[^\n.!?]{0,60}\b(?:files?|directories|folders?|databases?|tables?|branches?|backups?|accounts?|records?|everything)\b|\brm\s+-[a-z]*[rf][a-z]*\b|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*|push\s+[^\n]{0,80}--force(?:-with-lease)?)\b/i,
  ],
  [
    "engineering-or-external-change",
    /\b(?:implement|debug|fix|refactor|redesign|architect|migrate|deploy|rollback|release|publish)\b|\broll\s+back\b|\bgit\s+(?:commit|push|merge|rebase)\b/i,
  ],
];

// Inspect quoted material too: classifier-directed instructions in task data
// must not become an alternate way to authorize the fast lane.
const routingInstruction =
  /\b(?:ignore|disregard|override|bypass)\b[^\n]{0,100}\b(?:instructions?|rules?|routing|router|classifier|system\s+prompt)\b|\b(?:choose|select|pick|route|switch|send|use|prefer|return|output|classify|recommend|set)\b[^\n]{0,50}\b(?:fast|strong|uncertain)\b(?!(?:\s+(?:algorithm|sort|sorting|food|car|train))\b)|\b(?:routing|router|classifier)\s+(?:instructions?|rules?|decision)\s*:/i;

const explicitMissingFacts =
  /\b(?:i|we)\s+(?:haven['’]?t|have\s+not|didn['’]?t|did\s+not)\s+(?:provid(?:e|ed)|includ(?:e|ed)|supply|supplied|attach(?:ed)?|upload(?:ed)?|share(?:d)?)\b|\b(?:no|missing|unavailable|absent)\s+(?:required|essential|necessary)\s+(?:context|input|data|choices|options|code|files?|results?|outputs?|information|details)\b|\b(?:the|my|our)\s+(?:(?:required|essential|necessary)\s+)?(?:context|input|data|choices|options|code|file|document|result|output)\s+(?:is|are|was|were)\s+(?:missing|unavailable|absent|not\s+(?:provided|supplied|included|available|attached))\b|\b(?:unattached|unprovided|unsupplied)\s+(?:document|file|input|data|choices|options)\b/i;

const priorContextReference =
  /\b(?:use|using|from|format|summarize|transform|based\s+on|refer\s+to|according\s+to|compare\s+(?:with|to))\s+(?:(?:the|my|our)\s+)?(?:previous|prior|last|earlier|above)\s+(?:answer|result|output|message|exchange|context|code|file|run|discussion)\b|\b(?:what|which)\s+(?:was|were|is|are)\s+(?:the\s+)?(?:previous|prior|last|earlier)\s+(?:answer|result|output|choice)\b|\b(?:as\s+(?:we\s+)?discussed|continue\s+(?:the\s+)?(?:previous|prior|earlier)\s+(?:work|task|discussion))\b/i;

const vagueRequest =
  /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:take\s+care\s+of\s+(?:this|that|it)|make\s+(?:this|that|it)\s+better|do\s+(?:this|that|it)|handle\s+(?:this|that|it)|continue|carry\s+on|what\s+do\s+you\s+think)[.!?\s]*$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ");
}

function reject(reason: string): RoutingEligibility {
  return { eligibleForFast: false, reason };
}

/**
 * Supplementary conservative exclusions, not a task-quality classifier.
 * A pass requires independent artifact qualification and a confident classifier
 * decision. These patterns neither prove completeness nor calibrate confidence.
 */
export function evaluateRoutingEligibility(
  input: RoutingEligibilityInput,
): RoutingEligibility {
  if (!record(input)) return reject("invalid-input");
  if (
    typeof input.prompt !== "string" ||
    !normalize(input.prompt).trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt)
  ) {
    return reject("invalid-prompt");
  }
  if (
    input.essentialFactsAvailable !== undefined &&
    typeof input.essentialFactsAvailable !== "boolean"
  ) {
    return reject("invalid-essential-facts-flag");
  }
  if (
    input.artifactQualified !== undefined &&
    typeof input.artifactQualified !== "boolean"
  ) {
    return reject("invalid-artifact-qualification");
  }

  let previous = "";
  const exchange = input.previousExchange;
  if (exchange !== undefined) {
    if (typeof exchange === "string") previous = exchange;
    else if (
      record(exchange) &&
      typeof exchange.user === "string" &&
      typeof exchange.assistant === "string"
    ) {
      previous = `${exchange.user}\n${exchange.assistant}`;
    } else return reject("invalid-previous-exchange");
  }
  if (input.essentialFactsAvailable === false) {
    return reject("missing-essential-facts");
  }
  if (input.essentialFactsAvailable !== true) {
    return reject("essential-facts-unverified");
  }
  if (input.artifactQualified !== true) return reject("unqualified-artifact");

  const classification = input.classification;
  if (!record(classification))
    return reject("missing-or-invalid-classification");
  if (
    !["fast", "strong", "uncertain"].includes(
      classification.decision as string,
    ) ||
    typeof classification.confidence !== "number" ||
    !Number.isFinite(classification.confidence) ||
    classification.confidence < 0 ||
    classification.confidence > 1
  ) {
    return reject("invalid-classification");
  }
  if (classification.decision !== "fast") {
    return reject(`classifier-selected-${classification.decision}`);
  }
  if (classification.confidence < MINIMUM_FAST_CONFIDENCE) {
    return reject("classifier-confidence-below-threshold");
  }

  const prompt = normalize(input.prompt);
  const context = normalize(previous);
  const semanticInput = `${prompt}\n${context}`;
  if (routingInstruction.test(semanticInput)) {
    return reject("routing-instruction-in-input");
  }
  if (explicitMissingFacts.test(prompt))
    return reject("missing-essential-facts");
  if (
    !context.trim() &&
    (priorContextReference.test(prompt) || vagueRequest.test(prompt))
  ) {
    return reject("missing-referenced-context");
  }
  for (const [reason, pattern] of demandPatterns) {
    if (pattern.test(semanticInput)) return reject(reason);
  }
  return { eligibleForFast: true, reason: "qualified-classifier-fast" };
}
