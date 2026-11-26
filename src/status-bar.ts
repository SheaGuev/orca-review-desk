// What the status bar item says: the focused branch's guide, or how many reviews are waiting.
import type { QueueItem } from "./protocol";
import { RISK_WORD, type RiskLevel } from "./schema";

export type StatusBar = {
  text: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  tooltip?: string;
};

const RISK_TONE: Record<RiskLevel, StatusBar["tone"]> = {
  high: "danger",
  medium: "warning",
  low: "success",
};

/**
 * `focused` is the queue item of the focused workspace's branch, if it has one; `onRepo` says the
 * focused workspace is a GitHub repository at all; `waiting` counts the reviews you owe.
 */
export function statusBar(input: {
  focused: QueueItem | undefined;
  onRepo: boolean;
  waiting: number;
}): StatusBar {
  const { focused } = input;
  if (focused?.status === "generating")
    return { text: `Review Desk: writing #${focused.number}…`, tone: "accent" };
  if (focused?.risk)
    return {
      text: `Review Desk: ${RISK_WORD[focused.risk]} risk${focused.status === "stale" ? " (older commit)" : ""}`,
      tone: RISK_TONE[focused.risk],
      tooltip: (focused.riskSummary ?? "").slice(0, 200),
    };
  return {
    text: input.waiting ? `Reviews: ${input.waiting}` : "Review Desk",
    tone: "neutral",
    tooltip: input.onRepo ? "Open or generate the guide for this branch" : "Review Desk",
  };
}
