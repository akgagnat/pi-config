---
name: pr-planner
description: Policy for drafting a git branch name, commit message, and GitHub pull request title/body from selected local changes. Use when planning or reviewing the /pr workflow wording and structure.
---

# /pr Planner Policy

Use the provided repository context to draft exactly one branch name, one commit message, and one draft GitHub pull request.

## Branch naming

- When a new branch is needed, derive it from the change itself.
- Use lowercase kebab-case.
- Keep it concise and specific.
- Do not add unsupported scope or implementation details.

## Commit wording

- Use the imperative mood.
- Prefer a one-line subject.
- Add a short body only when it materially helps a reviewer.
- Keep the message specific to the selected changes.

## PR title

- Keep it concise and reviewer-friendly.
- Align it with the change intent without adding unsupported claims.

## PR body

Include these subsections:

- `### Summary`
- `### Testing`
- `### Risks / Notes`

Within those sections:

- Summarize only facts supported by the provided context.
- If testing information is unavailable, write `Not run`.
- If risks or notes are unavailable, write `None`.

## Deviation guidance

- Use only the selected change context.
- Diff text may be truncated; do not invent unsupported details.
