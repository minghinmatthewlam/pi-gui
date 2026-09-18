# Claude Code skill discovery

Claude Code loads repository skills from `.claude/skills/<name>/SKILL.md`. The
`pi` agent that this app wraps loads them from `.agents/skills/<name>/SKILL.md`,
which is where this repo's skills actually live.

The entries here are symlinks, so `.agents/skills/` stays the single source of
truth and both agents read the same files. Anything that already invokes a skill
by its `.agents/skills/...` path keeps working unchanged.

To add a skill: create it under `.agents/skills/<name>/`, then

```sh
ln -s ../../.agents/skills/<name> .claude/skills/<name>
```
