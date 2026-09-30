import type { Issue, PullRequest } from "./contract.ts";

// Task drafts are prepared, never sent: the person reads and edits them first.

export interface Draft {
  title: string;
  prompt: string;
}

const TITLE_MAX = 240;

function title(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

export function issueDraft(repo: string, issue: Issue): Draft {
  return {
    title: title(`Fix #${issue.number}: ${issue.title}`),
    prompt: [
      `Investigate and fix GitHub issue #${issue.number} in ${repo}: "${issue.title}".`,
      `Issue: ${issue.url}`,
      `Reported by @${issue.author}.`,
      issue.body
        ? `Issue description (excerpt):\n${quote(issue.body)}`
        : "The issue has no description.",
      "Read the full issue and its comments first (for example `gh issue view " +
        `${issue.number} --comments\`), reproduce the problem in this checkout, and find the root cause.`,
      "Then make a focused fix with a test that covers it, and summarize what changed and how you verified it.",
      "Don't comment on, label or close the issue.",
    ].join("\n\n"),
  };
}

export function pullRequestDraft(repo: string, pr: PullRequest): Draft {
  const header = `PR #${pr.number} in ${repo}: "${pr.title}"\n${pr.url}${pr.branch ? `\nBranch: ${pr.branch}` : ""}`;
  if (pr.checks.state === "failing") {
    return {
      title: title(`Fix failing CI on PR #${pr.number}`),
      prompt: [
        `Fix the failing CI on ${header}`,
        `Failing checks (${pr.checks.failed.length} of ${pr.checks.total}):\n${pr.checks.failed.map((name) => `- ${name}`).join("\n")}`,
        `Check out the PR branch, read the failing check logs (for example \`gh pr checks ${pr.number}\` and \`gh run view --log-failed\`), and reproduce each failure locally with the repository's own scripts.`,
        "Fix the root cause rather than skipping or loosening checks. Summarize each failure, its cause and the fix.",
        "Don't push, comment on or merge the PR.",
      ].join("\n\n"),
    };
  }
  if (pr.review === "changes_requested") {
    return {
      title: title(`Address review on PR #${pr.number}`),
      prompt: [
        `Address the requested changes on ${header}`,
        `Read the review comments (for example \`gh pr view ${pr.number} --comments\`) and the diff (\`gh pr diff ${pr.number}\`), then make the requested changes on the PR branch.`,
        "Summarize how each comment was addressed. Don't push, reply to reviewers or merge the PR.",
      ].join("\n\n"),
    };
  }
  return {
    title: title(`Review PR #${pr.number}: ${pr.title}`),
    prompt: [
      `Review ${header}`,
      `Read the diff (\`gh pr diff ${pr.number}\`) and the surrounding code. Look for concrete bugs, missing tests and behavior regressions introduced by this PR.`,
      "Report findings with file and line references, most important first. Don't post a review, push or merge.",
    ].join("\n\n"),
  };
}
