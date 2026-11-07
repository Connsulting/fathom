// Chronological 1,000-row replay: the lowest model confidence tail meeting 95% precision.
export const CONFIDENCE_POLICY = Object.freeze({ autoApply: 0.90, review: 0.84 });

export function confidenceBand(confidence, policy = CONFIDENCE_POLICY) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return 'uncategorized';
  if (policy.autoApply != null && confidence >= policy.autoApply) return 'auto';
  if (policy.review != null && confidence >= policy.review) return 'review';
  return 'uncategorized';
}
export const jevEvidence = () => "Fathom's categorization";
export const categoryEvidence = text => String(text).replace(/\b(?:jev(?:-[\d.]+)?|typesafe(?:\.ai)?|anthropic|openai|claude|gpt(?:-[\w.]+)?|gemini)\b/gi,'service')
  .replace(/\d+(?:\.\d+)?\s*%/g,'').replace(/[\r\n]+/g,' ');
