// A review drafted in the guide tab, and what GitHub is sent when it is posted. Pure: the worker
// does the posting, the editor and the tests share the rules.

import { isObj } from "./json";
import { DEEP_SEVERITIES, type Finding } from "./schema";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export const REVIEW_EVENTS: readonly ReviewEvent[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

export type DraftComment = {
  id: string;
  path: string;
  /** PR-head (RIGHT side) line; null comments on the whole file. The last line of a range. */
  line: number | null;
  /**
   * The first line of a multi-line comment, below `line` and in the same hunk; absent for a one-line
   * or whole-file comment (storage holds plain JSON, so it is left out rather than undefined).
   */
  startLine?: number;
  body: string;
  source: "manual" | `finding:${string}`;
};

export type Draft = {
  /** The PR head the draft was written against; line comments are re-checked if it moved. */
  commitId: string;
  body: string;
  comments: DraftComment[];
  dismissedFindings: string[];
};

export const emptyDraft = (commitId: string): Draft => ({
  commitId,
  body: "",
  comments: [],
  dismissedFindings: [],
});

/** A draft from storage or the frame, with anything malformed dropped rather than trusted. */
export function asDraft(value: unknown, fallbackCommit: string): Draft {
  if (!isObj(value)) return emptyDraft(fallbackCommit);
  const comments = Array.isArray(value.comments)
    ? value.comments.filter(
        (c): c is DraftComment =>
          isObj(c) &&
          typeof c.id === "string" &&
          typeof c.path === "string" &&
          c.path !== "" &&
          (c.line === null ||
            (typeof c.line === "number" && Number.isInteger(c.line) && c.line > 0)) &&
          typeof c.body === "string" &&
          (c.startLine === undefined ||
            (typeof c.startLine === "number" &&
              Number.isInteger(c.startLine) &&
              c.startLine > 0 &&
              typeof c.line === "number" &&
              c.startLine < c.line)) &&
          (c.source === "manual" ||
            (typeof c.source === "string" && c.source.startsWith("finding:"))),
      )
    : [];
  return {
    commitId:
      typeof value.commitId === "string" && value.commitId ? value.commitId : fallbackCommit,
    body: typeof value.body === "string" ? value.body : "",
    comments: comments.map(({ id, path, line, startLine, body, source }) => ({
      id,
      path,
      line,
      ...(startLine !== undefined ? { startLine } : {}),
      body,
      source,
    })),
    dismissedFindings: Array.isArray(value.dismissedFindings)
      ? value.dismissedFindings.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/** "line 38", "lines 34–38" or "the whole file": where a comment sits, in words. */
export function commentPlace(c: Pick<DraftComment, "line" | "startLine">): string {
  if (c.line === null) return "the whole file";
  return c.startLine !== undefined && c.startLine < c.line
    ? `lines ${c.startLine}–${c.line}`
    : `line ${c.line}`;
}

/**
 * Why GitHub would refuse a comment on lines `start`..`end` of `path`, or null when it takes it.
 * Both ends must be added or unchanged PR-head lines in the same hunk. A hunk's PR-head lines are
 * consecutive and hunks are separated by lines the diff does not show, so "every line between them
 * is commentable" is the same-hunk test, with no need for the hunk headers.
 */
export function rangeProblem(
  isCommentable: (path: string, line: number) => boolean,
  path: string,
  start: number,
  end: number,
): string | null {
  const [a, b] = start <= end ? [start, end] : [end, start];
  for (const n of [a, b])
    if (!isCommentable(path, n)) return `Line ${n} is not an added or unchanged line of this diff.`;
  for (let n = a + 1; n < b; n++)
    if (!isCommentable(path, n))
      return `Lines ${a} and ${b} are in different hunks: GitHub takes a range only within one hunk.`;
  return null;
}

/** Line comments that no longer sit on added or context lines (one hunk for a range) of the diff. */
export function staleComments(
  draft: Draft,
  isCommentable: (path: string, line: number) => boolean,
  changed: readonly string[],
): DraftComment[] {
  const files = new Set(changed);
  return draft.comments.filter(
    (c) =>
      !files.has(c.path) ||
      (c.line !== null &&
        rangeProblem(isCommentable, c.path, c.startLine ?? c.line, c.line) !== null),
  );
}

/** Why GitHub would refuse this review, before anything is sent; null when it can go. */
export function reviewProblem(
  draft: Draft,
  event: ReviewEvent,
  body: string,
  canApprove: boolean,
): string | null {
  if (!canApprove && event !== "COMMENT")
    return "GitHub does not let you approve or request changes on your own PR.";
  if (draft.comments.some((c) => !c.body.trim())) return "A comment in this review is empty.";
  const lineComments = draft.comments.filter((c) => c.line !== null).length;
  if (event === "REQUEST_CHANGES" && !body.trim())
    return "Say what needs to change in the summary.";
  if (event === "COMMENT" && !body.trim() && lineComments === 0)
    return "Write a summary or add a line comment.";
  return null;
}

export type ReviewPayload = {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: {
    path: string;
    line: number;
    side: "RIGHT";
    start_line?: number;
    start_side?: "RIGHT";
    body: string;
  }[];
};

/**
 * The one review GitHub gets: every line comment, on the PR head's RIGHT side. A range comment
 * names its first line too (`start_line`, `start_side`); GitHub puts it under the last.
 */
export function reviewPayload(
  draft: Draft,
  event: ReviewEvent,
  body: string,
  commitId: string,
): ReviewPayload {
  return {
    commit_id: commitId,
    event,
    body: body.trim(),
    comments: draft.comments
      .filter((c): c is DraftComment & { line: number } => c.line !== null)
      .map((c) => ({
        path: c.path,
        line: c.line,
        side: "RIGHT" as const,
        ...(c.startLine !== undefined && c.startLine < c.line
          ? { start_line: c.startLine, start_side: "RIGHT" as const }
          : {}),
        body: c.body.trim(),
      })),
  };
}

export type FileCommentPayload = {
  commit_id: string;
  path: string;
  body: string;
  subject_type: "file";
};

/** Whole-file comments, which GitHub only takes one at a time outside a review. */
export function fileCommentPayloads(
  draft: Draft,
  commitId: string,
): { comment: DraftComment; payload: FileCommentPayload }[] {
  return draft.comments
    .filter((c) => c.line === null)
    .map((c) => ({
      comment: c,
      payload: { commit_id: commitId, path: c.path, body: c.body.trim(), subject_type: "file" },
    }));
}

/** "One thing" / "3 things": a count in words that read well at the start of a sentence too. */
const count = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`);

/**
 * A starting summary for the review: its shape, from the findings the reviewer added. How many
 * must be fixed before merging (blocker, major) and how many are smaller (minor, nit), then a
 * pointer to the comments. Never their text: each one is already a line or file comment, and
 * GitHub shows the summary right above them. Empty when no finding was added; the reviewer
 * edits it before anything is posted.
 */
export function suggestedSummary(draft: Draft, findings: readonly Finding[]): string {
  const added = new Set(draft.comments.map((c) => c.source));
  const used = findings.filter((f) => added.has(`finding:${f.id}`));
  if (!used.length) return "";
  const must = used.filter((f) => DEEP_SEVERITIES.includes(f.severity)).length;
  const small = used.length - must;
  const fix = count(must, "One thing", "things") + " to fix before this merges";
  const rest = count(small, "one smaller suggestion", "smaller suggestions");
  const shape = !must
    ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}, nothing blocking.`
    : small
      ? `${fix}, and ${rest}.`
      : `${fix}.`;
  return `${shape} Details are in the comments.`;
}

/**
 * The blocker and major findings the reviewer has not acted on: no comment from them in the
 * review and not dismissed. What the wrap-up asks about before anything is posted.
 */
export function openFindings(draft: Draft, findings: readonly Finding[]): Finding[] {
  const added = new Set(draft.comments.map((c) => c.source));
  return findings.filter(
    (f) =>
      DEEP_SEVERITIES.includes(f.severity) &&
      !added.has(`finding:${f.id}`) &&
      !draft.dismissedFindings.includes(f.id),
  );
}
