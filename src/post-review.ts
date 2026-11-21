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
 * Posts the draft as one GitHub review (line comments inside it), then each whole-file comment,
 * which GitHub only takes on its own, one after the other so they keep the draft's order. Throws
 * when the review itself is refused; a refused file comment is returned instead.
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
