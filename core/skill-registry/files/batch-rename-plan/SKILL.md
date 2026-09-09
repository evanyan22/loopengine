---
name: batch-rename-plan
description: Turn a batch-renaming request into an explicit old-name -> new-name mapping for a set of files, without renaming anything yet. Use when asked to rename many files following a pattern.
---

# Batch rename plan

Produce the mapping, don't execute the renames yourself unless
separately asked to — a batch rename is exactly the kind of bulk,
hard-to-reverse operation that should be shown to a human (or an
explicit follow-up step) before it happens, not applied silently as a
side effect of "planning" it.

## Output

A table or list of `old-name -> new-name` pairs, covering every file in
the target set — not a description of the rule in prose alone. A human
reviewing this should be able to tell exactly what will happen to each
file without re-deriving it from the rule themselves.

## Rules

- **Collisions**: if the plan would make two different files land on the
  same new name, stop and flag it — never silently drop or overwrite one.
- **No-ops**: a file whose new name is identical to its old name is fine
  to list as a no-op, or to omit — say which you're doing, don't leave it
  ambiguous.
- **Unmatched files**: if some files in the set don't match the stated
  pattern at all, list them separately as "unchanged / didn't match"
  rather than silently excluding them from the plan.
- **Extensions**: preserve a file's extension unless the request
  explicitly asks to change it.

## Applying the plan

Only actually rename files if asked to apply the plan (not just produce
it), and only using the exact mapping already shown — never rename
something that wasn't in the reviewed list, even if it looks like it
should obviously follow the same rule.
