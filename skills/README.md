# Global skills

This directory is for a `SKILL.md` genuinely meant to be shared across
more than one agent — nothing here today, because nothing in this repo's
own demo agents currently needs to be. Every existing skill is
agent-specific and lives under that agent's own folder instead:
`agents/customer-service/skills/`, `agents/file-agent/skills/`.

If a skill's knowledge or instructions genuinely apply to more than one
agent, it belongs here — same `<skill-name>/SKILL.md` shape SkillGarden
already expects, just without a per-agent subfolder (unlike
`agents/<name>/skills/`, there's no single agent to namespace by):

```
skills/
  some_shared_skill/
    SKILL.md
```

Point more than one agent's `skillsDirs` at this same root to actually
share it. Don't point an agent at this root *and* its own
`agents/<name>/skills/` unless you mean for it to see both — SkillGarden's
discovery recursively walks whatever directories it's given with no
per-agent filtering, so any agent pointed at this root sees every skill
under it, not just the one it needed.

Don't put an agent-specific skill here just because it feels reusable in
theory. Wait for a second agent that actually needs the exact same
knowledge before moving it here — see the root README's "Skills" section
for the fuller reasoning.
