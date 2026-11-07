export const CONFIDENCE_POLICY = Object.freeze({ autoApply: 0.99, review: 0.84 });

export function confidenceBand(confidence, policy = CONFIDENCE_POLICY) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'uncategorized';
  if (policy.autoApply != null && confidence >= policy.autoApply) return 'auto';
  if (policy.review != null && confidence >= policy.review) return 'review';
  return 'uncategorized';
}
export const jevEvidence = confidence => `Jev guess, ${Math.round(confidence * 100)}% confident`;
