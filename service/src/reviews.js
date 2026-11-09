import { config } from './config.js';
import * as gh from './gh.js';
import * as store from './store.js';
import { hunkFor } from './placement.js';
import { mapComment } from './threads.js';
import { ApiError } from './errors.js';

const EVENTS = new Set(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);
const SIDES = new Set(['LEFT', 'RIGHT']);

export function validateReview(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'bad_request', 'body must be a JSON object');
  }
  if (!EVENTS.has(input.event)) {
    throw new ApiError(400, 'bad_request', 'event must be COMMENT, APPROVE or REQUEST_CHANGES');
  }
  if (typeof input.expectedHeadSha !== 'string' || !input.expectedHeadSha) {
    throw new ApiError(400, 'bad_request', 'expectedHeadSha is required');
  }
  if (typeof input.body !== 'string') {
    throw new ApiError(400, 'bad_request', 'body must be a string');
  }
  if (!Array.isArray(input.comments)) {
    throw new ApiError(400, 'bad_request', 'comments must be an array');
  }
  input.comments.forEach((comment, index) => {
    if (!comment || typeof comment !== 'object') {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '] must be an object');
    }
    if (typeof comment.path !== 'string' || !comment.path) {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].path is required');
    }
    if (!Number.isInteger(comment.line) || comment.line < 1) {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].line must be a positive integer');
    }
    if (!SIDES.has(comment.side)) {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].side must be LEFT or RIGHT');
    }
    if (typeof comment.body !== 'string') {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].body must be a string');
    }
    if (comment.startLine !== undefined && (!Number.isInteger(comment.startLine) || comment.startLine < 1)) {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].startLine must be a positive integer');
    }
    if (comment.startSide !== undefined && !SIDES.has(comment.startSide)) {
      throw new ApiError(400, 'bad_request', 'comments[' + index + '].startSide must be LEFT or RIGHT');
    }
  });
}

function insideDiff(story, comment) {
  const found = hunkFor(story, comment.path, comment.side, comment.line);
  if (!found) return false;
  if (comment.startLine === undefined) return true;
  const startSide = comment.startSide || comment.side;
  // A range keeps one side and must run forward: start_line < line, both ends in the same hunk.
  if (startSide !== comment.side || comment.startLine >= comment.line) return false;
  const start = hunkFor(story, comment.path, startSide, comment.startLine);
  return Boolean(start && start.hunk.id === found.hunk.id);
}

export async function postReview(repo, number, request) {
  const head = await gh.prHeadSha(repo, number);
  if (head !== request.expectedHeadSha) {
    throw new ApiError(409, 'head_moved', 'PR head is now ' + head, { currentHeadSha: head });
  }
  const story = await store.readStory(repo, number, request.expectedHeadSha);
  if (!story) {
    throw new ApiError(404, 'not_found', 'no story for ' + request.expectedHeadSha);
  }

  const comments = [];
  const movedToFileLevel = [];
  request.comments.forEach((comment, index) => {
    if (!insideDiff(story, comment)) {
      movedToFileLevel.push(index);
      return;
    }
    const entry = { path: comment.path, line: comment.line, side: comment.side, body: comment.body };
    if (comment.startLine !== undefined) {
      entry.start_line = comment.startLine;
      entry.start_side = comment.startSide || comment.side;
    }
    comments.push(entry);
  });

  const payload = {
    commit_id: request.expectedHeadSha,
    event: request.event,
    body: request.body || '',
    comments,
  };
  const reviewPath = '/repos/' + repo + '/pulls/' + number + '/reviews';
  let review;
  if (config.dryRun) {
    console.error('[dry-run] POST ' + reviewPath + ' ' + JSON.stringify(payload));
    review = {
      id: 900001,
      html_url: 'https://github.com/' + repo + '/pull/' + number + '#pullrequestreview-900001',
    };
  } else {
    review = await gh.rest('POST', reviewPath, payload);
  }

  const commentPath = '/repos/' + repo + '/pulls/' + number + '/comments';
  for (const index of movedToFileLevel) {
    const comment = request.comments[index];
    const filePayload = {
      body: comment.body,
      commit_id: request.expectedHeadSha,
      path: comment.path,
      subject_type: 'file',
    };
    if (config.dryRun) {
      console.error('[dry-run] POST ' + commentPath + ' ' + JSON.stringify(filePayload));
      continue;
    }
    try {
      await gh.rest('POST', commentPath, filePayload);
    } catch (err) {
      throw new ApiError(
        err.status === 422 ? 422 : 502,
        err.status === 422 ? 'github_rejected' : 'github_unavailable',
        'review ' + review.id + ' posted, but file comment ' + index + ' failed: ' + err.message,
      );
    }
  }

  return { reviewId: review.id, url: review.html_url, movedToFileLevel };
}

export async function replyToThread(threadId, body) {
  if (typeof body !== 'string' || !body.trim()) {
    throw new ApiError(400, 'bad_request', 'body is required');
  }
  const query = `
    mutation($id: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
        comment {
          id
          url
          body
          bodyHTML
          createdAt
          author { login avatarUrl __typename }
          reactionGroups { content viewerHasReacted reactors { totalCount } }
        }
      }
    }
  `;
  if (config.dryRun) {
    console.error('[dry-run] graphql addPullRequestReviewThreadReply ' + JSON.stringify({ threadId, body }));
    return {
      id: 'PRRC_dry_run_900002',
      author: { login: await gh.currentLogin(), avatarUrl: '', isBot: false },
      body,
      bodyHtml: '<p>' + body + '</p>',
      createdAt: new Date().toISOString(),
      url: 'https://github.com/dry-run#discussion_r900002',
      reactions: [],
    };
  }
  const data = await gh.graphql(query, { id: threadId, body });
  const comment = data.addPullRequestReviewThreadReply?.comment;
  if (!comment) throw new ApiError(422, 'github_rejected', 'GitHub returned no comment');
  return mapComment(comment);
}

export async function setThreadResolved(threadId, resolved) {
  const mutation = resolved
    ? 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }';
  const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  if (config.dryRun) {
    console.error('[dry-run] graphql ' + field + ' ' + JSON.stringify({ threadId }));
    return { isResolved: resolved };
  }
  const data = await gh.graphql(mutation, { id: threadId });
  const thread = data[field]?.thread;
  if (!thread) throw new ApiError(422, 'github_rejected', 'GitHub returned no thread');
  return { isResolved: Boolean(thread.isResolved) };
}

const REACTIONS = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'];

export async function setReaction(commentId, content, on) {
  if (!REACTIONS.includes(content)) throw new ApiError(400, 'bad_request', 'unknown reaction');
  const field = on ? 'addReaction' : 'removeReaction';
  const mutation = 'mutation($id: ID!, $content: ReactionContent!) { ' + field + '(input: { subjectId: $id, content: $content }) { reaction { content } } }';
  if (config.dryRun) {
    console.error('[dry-run] graphql ' + field + ' ' + JSON.stringify({ commentId, content }));
    return { ok: true };
  }
  await gh.graphql(mutation, { id: commentId, content });
  return { ok: true };
}
