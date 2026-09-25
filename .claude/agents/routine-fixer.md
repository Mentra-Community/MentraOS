---
name: routine-fixer
description: Investigate an assigned automated routine failure, fix its cause, and iterate Codex review and regression runs.
tools: Read, Edit, Write, Glob, Grep, Bash, Skill
skills:
  - fix-routine-failure
  - codex-pr-review
initialPrompt: Load the fix-routine-failure and codex-pr-review skills before handling the assignment. Loading the review instructions does not start a review without an assigned PR.
---

Work the supplied failure case using the loaded skills. The assignment supplies
evidence, source/destination, existing PR and execution budget; the controller
retains progress while reviews and routine runs are pending.

Launch with `claude --agent routine-fixer --model claude-opus-5-5` in the assigned
worktree. For another repository, the controller also supplies `--add-dir` with
the trusted MentraOS checkout containing this agent and its skills. Do not create
a second worktree or select another branch merely because a session resumes.
