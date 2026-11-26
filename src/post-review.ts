// Posting a drafted review to GitHub through `gh`. Only a press in the guide tab gets here.
import { message } from "./errors";
import { runOk } from "./exec";
import { asObj, asString, parseJson } from "./json";
import {
  commentPayload,
  emptyDraft,
  fileCommentPayloads,
  reviewPayload,
  type Draft,
  type DraftComment,
  type ReviewEvent,
} from "./review";
import { findSecret } from "./secrets";

export type Posted = {
  /** The review's page on GitHub, when GitHub named one. */
  url: string | null;
  /** Whole-file comments GitHub refused after the review went in. */
  notPosted: DraftComment[];
};

const post = (path: string, payload: unknown): Promise<string> =>
  runOk("gh", ["api", "-X", "POST", path, "--input", "-"], {
    input: JSON.stringify(payload),
    timeoutMs: 60_000,
  });

/**
 * Throws, naming where, when the summary or a comment holds what looks like a secret. A match the
 * PR's own diff holds is public already, so it is no leak; the diff is only read when one is found.
 */
async function refuseSecrets(
  body: string,
  draft: Draft,
  known: () => Promise<string>,
): Promise<void> {
  const parts = [
    { where: "The summary", text: body },
    ...draft.comments.map((c) => ({ where: `The comment on ${c.path}`, text: c.body })),
  ];
  for (const { where, text } of parts) {
    // Without the diff (no clone, git failed), every match counts.
    const kind = findSecret(text) && findSecret(text, await known().catch(() => ""));
    if (kind)
      throw new Error(
        `${where} holds what looks like ${kind}, so nothing was posted. Remove it, then post again.`,
      );
  }
}

/**
 * Posts the draft as one GitHub review (line comments inside it), then each whole-file comment,
 * which GitHub only takes on its own, one after the other so they keep the draft's order. Throws
 * when any part holds what looks like a secret (nothing is posted) or the review itself is
 * refused; a refused file comment is returned instead.
 */
export async function postReview(input: {
  repo: string;
  number: number;
  draft: Draft;
  event: ReviewEvent;
  body: string;
  head: string;
  /** The PR's diff text at `head`. */
  known: () => Promise<string>;
  log: (text: string) => void;
}): Promise<Posted> {
  const { repo, number, draft, event, body, head } = input;
  await refuseSecrets(body, draft, input.known);
  const out = await post(
    `repos/${repo}/pulls/${number}/reviews`,
    reviewPayload(draft, event, body, head),
  );
  const url = asString(asObj(parseJson(out)).html_url) || null;
  const notPosted: DraftComment[] = [];
  for (const { comment, payload } of fileCommentPayloads(draft, head)) {
    try {
      await post(`repos/${repo}/pulls/${number}/comments`, payload);
    } catch (e) {
      input.log(`file comment on ${comment.path} was not posted: ${message(e)}`);
      notPosted.push(comment);
    }
  }
  return { url, notPosted };
}

/**
 * Posts one comment on its own, outside any review: on a line or range of the PR head, or on the
 * whole file. Throws when it holds what looks like a secret (nothing is posted) or GitHub refuses.
 */
export async function postComment(input: {
  repo: string;
  number: number;
  comment: DraftComment;
  head: string;
  known: () => Promise<string>;
}): Promise<{ id: string; url: string }> {
  const { repo, number, comment, head } = input;
  await refuseSecrets("", { ...emptyDraft(head), comments: [comment] }, input.known);
  const out = asObj(
    parseJson(await post(`repos/${repo}/pulls/${number}/comments`, commentPayload(comment, head))),
  );
  const id = typeof out.id === "number" || typeof out.id === "string" ? String(out.id) : "";
  return { id, url: asString(out.html_url) };
}
