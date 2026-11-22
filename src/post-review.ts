// Posting a drafted review to GitHub through `gh`. Only a press in the guide tab gets here.
import { message } from "./errors";
import { runOk } from "./exec";
import { asObj, asString, parseJson } from "./json";
import {
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

/** Throws, naming where, when the summary or a comment holds what looks like a secret. */
function refuseSecrets(body: string, draft: Draft): void {
  const parts = [
    { where: "The summary", text: body },
    ...draft.comments.map((c) => ({ where: `The comment on ${c.path}`, text: c.body })),
  ];
  for (const { where, text } of parts) {
    const kind = findSecret(text);
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
  log: (text: string) => void;
}): Promise<Posted> {
  const { repo, number, draft, event, body, head } = input;
  refuseSecrets(body, draft);
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
