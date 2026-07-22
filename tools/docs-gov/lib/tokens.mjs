// Token estimation for context budgets.
//
// Budgets measure tokens, not lines, because an agent pays for tokens: a
// 200-line table and a 200-line prose section have very different context
// costs, and line counts hide that. The estimator is bytes/4 — the standard
// English-prose approximation for BPE tokenizers (GPT and Claude families
// both land near 4 bytes/token on markdown prose).
//
// Deliberately NOT a real tokenizer: a tokenizer dependency would tie every
// consumer repo's gate to one vendor's vocabulary and version, and a vocab
// bump would move every budget number at once. The estimate is deterministic,
// dependency-free, and monotone in document size — which is all a ratchet
// needs, since budgets are set and compared using the same estimator.

export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
