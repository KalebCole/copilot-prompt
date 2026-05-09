/**
 * Minimal safety net for LLM output — strips code fences and horizontal rules.
 * Used as the fallback inside extractRewrite when the model didn't wrap its output.
 */
export function sanitizePrompt(text) {
  if (!text) return text;
  let s = text;
  s = s.replace(/^```\w*\n?/gm, "").replace(/\n?```$/gm, "");
  s = s.replace(/^---+\s*$/gm, "");
  return s.trim();
}
