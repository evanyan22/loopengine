# loopengine packages: installable tool+skill+actauth bundles

**Status: design spec — not yet implemented.** This document specifies
what a "loopengine package" is and how installing/upgrading one would
work, so it can be built incrementally against a fixed contract instead
of improvised per-PR. Nothing below exists in code yet.

## The problem this solves

Today, giving an agent a new capability that talks to some external
system means hand-authoring three independent artifacts, with nothing
tying them together:

1. One or more tool files in `agents/<name>/tools/*.ts` (hand-written,
   or admin-generated via `web/http-tool-admin.ts`).
2. A skill (`SKILL.md`) teaching the agent how/when to use them, if the
   usage pattern isn't obvious from the tool's own description alone.
3. One or more `actauth.yml` rules — without them, `default_decision`
   (usually `deny`) blocks the tool outright.

A real integration (see the FreeScout/Everymarket work this spec grew
out of) is always *all three together* — two order-lookup tools, a skill
describing the inbound message format, and the actauth rules allowing
them. There is currently no way to package that as one shareable,
installable unit; every agent that wants it re-derives it from scratch.

A **loopengine package** is that unit: a bundle of tool files, skill
directories, and actauth rule snippets, installed by copying files into
an agent's own tree — not by adding a runtime `node_modules` dependency.

## Private vs. public packages

The FreeScout/Everymarket example above is a **private** package, and
it's worth being explicit about that rather than implying broader reuse
than it actually has: `get_order_onway`/`get_order_shipments_detail`
hardcode Everymarket's own API shape (its specific ransack-style query
params, its specific endpoint structure) — reusable across Everymarket's
*own* agents and environments (staging vs. prod, different mailboxes),
not by some other company, since nobody else's backend speaks that exact
API.

That's a legitimate, common case on its own — most packages most
companies will ever write are private, internal-reuse packages like this
one, published to a private registry or just a git repo, never intended
for a public catalog. A **public** package is the narrower case: built
against a genuinely multi-tenant API (Stripe, Shopify, Zendesk) that many
different companies' agents could equally call. Nothing in the format
above distinguishes the two — the difference is just where you publish
it and who your tools' own `fetch()` calls actually point at — but the
public catalog considered under "out of scope for v1" below only makes
sense for the latter kind.

## Why copy, not import

The alternative — publish tools as an npm package, `import` them at
runtime — was deliberately rejected. It's inconsistent with a rule
already established for admin-generated tools (`web/http-tool-admin.ts`'s
own header comment on `generateToolCode`): a tool should be "the same
class of artifact a human would have written by hand," real, readable,
hand-editable, sitting in the agent's own `tools/` directory — not an
opaque import whose behavior lives outside the project and outside
actauth's ability to have been reasoned about at review time.

Copying means:

- A package's tool code is reviewable in the same PR that installs it —
  it's just files in the repo, like any other change.
- It can be hand-edited after install, same as an admin-generated HTTP
  tool already can be (with the same tradeoff: hand-edits and future
  package upgrades can now conflict — see "Upgrading" below, which
  reuses the exact merge machinery `create-loopengine upgrade` already
  has for this reason).
- No new "trust this code at import time" surface — actauth already
  governs *calling* a tool; this keeps *installing* one just as visible.

## Package format

A package is a directory (published to npm or git, same distribution
`create-loopengine` itself already uses) with this shape:

```
my-order-tools/
  package.json                # name, version — an ordinary npm package
  loopengine.package.json      # the manifest (see below)
  tools/
    get_order_onway.ts
    get_order_shipments_detail.ts
  skills/
    order-lookup/
      SKILL.md
  actauth/
    rules.yml
```

`loopengine.package.json`:

```json
{
  "name": "everymarket-order-tools",
  "version": "1.0.0",
  "loopengineVersion": "^0.1.10",
  "tools": ["tools/get_order_onway.ts", "tools/get_order_shipments_detail.ts"],
  "skills": ["skills/order-lookup"],
  "actauth": "actauth/rules.yml",
  "env": [
    { "name": "EM_ACCESS_TOKEN", "description": "Everymarket API access token", "secret": true },
    { "name": "EM_BEARER_TOKEN", "description": "Bearer token for onway/shipments_detail", "secret": true }
  ]
}
```

- `tools` — file paths, relative to the package root, each expected to
  `export const <camelCase> : ToolDefinition`, one per file — same
  shape `generateToolCode`'s own output already has, so hand-written and
  admin-generated tools are both valid package contents unmodified.
- `skills` — directory paths, each a complete `SKILL.md` (+ any
  scripts/assets alongside it), copied as-is into the installing agent's
  `skills/` directory.
- `actauth` — one YAML file of rule objects (`name`, `scope`, `tool`,
  `decision` — same shape `agents/<name>/actauth.yml` already uses),
  appended into the installing agent's own `actauth.yml` rather than
  replacing it.
- `loopengineVersion` — a semver range, checked against the installing
  project's own `loopengine` dependency before anything is written;
  refuse rather than install something that imports an export the
  installed `loopengine` version doesn't have yet (this is exactly the
  gap that caused the Parallel-safe checkbox to silently do nothing
  earlier — a package install is a second place that exact failure mode
  can recur if unchecked).
- `env` — optional. Every `process.env.X` a package's tools actually read
  (the same env-sourced secrets the HTTP tool builder's own `{{ENV_VAR}}`
  header syntax already produces, or a hand-written tool's own
  `process.env` read — either way, declared once here rather than
  buried in each tool file for an installer/admin to have to go find).
  `secret: true` means the Admin UI never echoes the value back once
  set — see "Managing package secrets in the Admin UI" below.

## Installing

```
npx loopengine add-package <npm-package> --agent customer-service
```

A `loopengine` subcommand, not a `create-loopengine` one — two reasons.
First, precedent: `bin/cli.ts` already has `scaffoldAgent`, adding a new
*agent* to an already-scaffolded project, the same granularity of
operation as adding a *package* to one — that's `loopengine`'s own
territory already, not `create-loopengine`'s (whole-project creation and
template-file upgrades only). Second, reliability: `create-loopengine`
is never a dependency of the scaffolded project itself (its own
template's `package.json` only lists `loopengine`/`actauth`), so every
`npx create-loopengine@latest ...` invocation
re-fetches the CLI package over the network — fine for `upgrade`, a
rare per-release operation, but not for something that could be invoked
as often as adding a package might be. `loopengine add-package` runs off
the project's own already-installed `node_modules/.bin/loopengine`
instead.

Named `add-package` — `add`, not `install`, for the same reasoning
shadcn/ui's own `npx shadcn add <component>` already uses: "install"
implies a live dependency you `import`; this copies files into the
project instead, and the verb should say so. The `-package` suffix (not
just bare `add`) keeps it alongside `upgrade-package`/`remove-package`
as one clearly-related family, and leaves `add` itself free — `add-agent`/
`add-subagent` already exist as their own, unrelated commands on this
same CLI.

What it does, in order — refusing outright, before writing anything, on
the first check that fails:

1. **Version check.** Read the installing project's own `package.json`
   `dependencies.loopengine`; refuse if it doesn't satisfy the package's
   `loopengineVersion` range.
2. **Fetch.** `npm pack <package>` into a temp dir and extract — the
   exact technique `fetchPublishedTemplateDir` already uses to pull a
   historical `create-loopengine` template; no new fetch mechanism
   needed.
3. **Collision check.** For every tool the manifest lists, check whether
   `agents/<agent>/tools/<name>.ts` already exists; for every actauth
   rule, check whether a rule of that `name` already exists in the
   target `actauth.yml`; for every skill, check whether
   `agents/<agent>/skills/<id>/` already exists. Refuse the whole
   install on any collision — same "refuse rather than guess" rule
   `HttpToolExistsError`/`HttpToolIndexShapeError` already enforce for a
   single admin-created tool, just applied package-wide so an install is
   all-or-nothing, never half-applied.
4. **Write tool files**, then patch `tools/index.ts` — reusing
   `addToolToIndex` (`web/http-tool-admin.ts`) exactly as-is, called once
   per tool in the package.
5. **Copy skill directories** into `agents/<agent>/skills/`.
6. **Append actauth rules** into `agents/<agent>/actauth.yml`, under a
   generated comment marking which package/version they came from (see
   next section — this comment is what upgrade/uninstall key off of).
7. **Record provenance** in `agents/<agent>/.loopengine-packages.json`:

   ```json
   {
     "everymarket-order-tools": {
       "version": "1.0.0",
       "files": ["tools/get_order_onway.ts", "..."],
       "env": ["EM_ACCESS_TOKEN", "EM_BEARER_TOKEN"]
     }
   }
   ```

   Same role `.create-loopengine.json` already plays for template
   files — the merge base a future `upgrade` needs, the manifest
   `uninstall` needs to know what's safe to remove, and (new) the `env`
   list is what the Admin UI reads to know which vars to prompt for —
   see next section. Installing doesn't write `.env` itself; it only
   registers that these names are now relevant.

## Managing package secrets in the Admin UI

Two things make this feature more sensitive than the rest of the admin
surface, and the design accounts for both directly.

First: `.env` is already gitignored (both the main repo's and the
scaffold template's `_gitignore`), so writing secrets there is safe from
the "don't commit a token" angle — but `LOOPENGINE_ADMIN_AUTH` itself is
**optional today**, just a startup warning if unset
(`adapters/http.ts:1443-1446` — "every route on this server ... is open
to anyone who can reach it"), not enforced. Letting the UI write raw
secret values makes an already-open deployment meaningfully worse than
today's gap (config/business data vs. actual credentials). So: **this
specific feature refuses to run at all if `LOOPENGINE_ADMIN_AUTH` isn't
set** — a hard requirement, not a warning, unlike the rest of the admin
surface.

Second: once set, a `secret: true` value is never echoed back — same
rule `web/http-tool-admin.ts` already established for a header value
referencing `{{ENV_VAR}}` (never persisted as a literal, never returned
through the admin API). The UI shows only `set` / `not set` status per
declared var, never the value.

Mechanically:

- The Admin UI reads every installed package's `env` list (from every
  agent's `.loopengine-packages.json`) and shows one row per declared
  var: name, description, and whether `process.env[name]` currently has
  a value.
- Submitting a new value does two things, not one: upserts the
  `KEY=VALUE` line into the project's `.env` file (a new small
  parse-and-upsert utility — preserve every other line/comment, replace
  or append the one key), and sets `process.env[name]` on the *current*
  running process immediately, so a newly-installed package's tools work
  without a restart.

## Upgrading

```
npx loopengine upgrade-package everymarket-order-tools --agent customer-service
```

Per file the package manages, the same three-way merge technique
`create-loopengine upgrade` already uses for template files
(`threeWayMerge`, `git merge-file --diff3`) — reimplemented here rather
than shared as code, since `loopengine` and `create-loopengine` are
separate published packages and a runtime depending on a scaffolding
tool (or vice versa) isn't a dependency direction worth introducing just
to share ~30 lines: "mine" is the file
currently in the agent's tree (possibly hand-edited since install),
"base" is the version recorded at the install/last-upgrade's own
published version (fetched via `npm pack <package>@<old-version>`,
same technique), "theirs" is the newly published version. A clean merge
writes through; a real conflict leaves `<<<<<<<` markers for a human,
identical to how a template-file upgrade conflict already surfaces
today — no new conflict-resolution UX to design.

actauth rules and skills upgrade the same way: a rule/skill unchanged
between the recorded base and the new version is left alone; a hand-edit
gets three-way-merged, not silently overwritten.

## Uninstalling

```
npx loopengine remove-package everymarket-order-tools --agent customer-service
```

Removes exactly the files `.loopengine-packages.json` recorded — refuses
if any of them look hand-modified beyond what a normal upgrade would
have produced (same conflict-detection the upgrade path already needs,
reused here as a safety check rather than silently deleting edited
work).

## Publishing a package

No new tooling needed beyond `loopengine.package.json` itself — a
package is an ordinary npm package. `npm publish` from a directory
shaped as above is a complete, valid loopengine package, whether that's
`npm publish` to the public registry, to a private one (a scoped
`@company/pkg`, GitHub Packages, a self-hosted Verdaccio), or just a
tagged commit in a private git repo with no registry involved at all —
`npm pack` accepts any of those as its target, not just a public
registry name, so `loopengine add-package`/`upgrade-package` take whatever
string the operator would already pass to `npm pack` (`@company/pkg`,
`github:org/repo#v1.0.0`, `git+ssh://...`, even `file:../local-path` for
testing) rather than assuming public npm. Auth for a private target
comes entirely from whatever `.npmrc` token or SSH key/git-credential
helper is already configured in the environment running the command —
no new auth system for loopengine itself to own.

One correction to the fetch step above: it's the same `npm pack`
*command* `fetchPublishedTemplateDir` already uses, generalized to a
caller-supplied spec instead of a hardcoded package name — that function
itself only ever fetches `create-loopengine@<version>`, so "already
handles git/npm sources" would overstate what it currently demonstrates;
accepting an arbitrary spec (public, private-registry, or git) is a
small but real generalization, not something already proven to work
today.

## Explicitly out of scope for v1

- **A public catalog/marketplace UI.** The Admin UI's Skills tab used to
  have a small bundled-skill catalog browser, removed once it became
  clear a two-entry, hand-maintained registry wasn't earning its keep —
  see `add-package` install straight from a spec instead of a curated
  catalog. A real catalog/marketplace UI for tool packages is a bigger,
  separate bet, not required to ship v1's install/upgrade mechanics.
- **Inter-package dependencies.** A package can't declare "requires
  package X installed first." Every package is self-contained.
- **Semver-range installs** (`add-package <package>@^1.0.0`) — v1 always
  installs latest; ranges are a straightforward follow-on once the
  provenance-tracking above exists to check against.
- **Per-user enable/disable of an installed package** (Pi's own
  extension model supports this) — v1's install is binary, in the
  agent's tree or not; toggling without uninstalling is a real gap this
  spec doesn't attempt to close yet.

## Open questions — not yet decided

- Should a package be allowed to target more than one agent in a single
  install (a monorepo with several agents that all want the same
  tools), or is `--agent` always singular and a multi-agent install is
  just running the command more than once?
- `actauth` rule scope today is written relative to one agent
  (`run-agent.ts` appends `/<agentName>` automatically) — does a
  package's `actauth/rules.yml` ever need to express a scope narrower
  than "this whole agent," and if so, how does the manifest express
  that without the package author needing to know the installing
  agent's name in advance?
- Does `loopengineVersion` need to be checked against `actauth`'s own
  version too, given a package's tool content could equally depend on
  an actauth feature that's version-gated?
- There's one `.env` per *project*, not per agent — if two agents in the
  same project each install a (possibly different) package that happens
  to declare the same env var name for an unrelated purpose, the Admin
  UI's "set/not set" status and the single value in `.env` can't
  actually distinguish them. Does the manifest need to namespace/prefix
  declared names somehow, or is a same-name collision across unrelated
  packages rare enough in practice to leave undetected for v1?
