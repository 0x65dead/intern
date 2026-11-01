// Shared OpenSea stage taxonomy. Kept separate from opensea.ts and stages.ts
// so the API parser and the stage table cannot disagree about a stage's kind.

export type StageKind = "gtd" | "team" | "allowlist" | "fcfs" | "public" | "unknown";

export const STAGE_ORDER: StageKind[] = ["team", "gtd", "allowlist", "fcfs", "public", "unknown"];

/**
 * Classify a stage using both OpenSea's broad type and the creator's label.
 * FCFS and GTD are often sent as generic stage types; the label identifies
 * the actual gated window and must take precedence over "public_sale".
 */
export function stageKindOf(type: string, label = ""): StageKind {
  const haystack = `${type} ${label}`.toLowerCase();

  if (/\bteam\b|founder|artist|reserve/.test(haystack)) return "team";
  if (/\bgtd\b|guarantee/.test(haystack)) return "gtd";
  if (/fcfs|first[- ]come|waitlist|raffle/.test(haystack)) return "fcfs";
  if (/public/.test(haystack)) return "public";
  if (/allow[- ]?list|presale|whitelist|\bwl\b/.test(haystack)) return "allowlist";
  return "unknown";
}
