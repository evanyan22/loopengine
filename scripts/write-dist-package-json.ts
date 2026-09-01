// tsc doesn't emit a package.json, so dist/ has no package boundary of its
// own — every #core/foo.js subpath import inside the compiled output
// resolves against the *root* package.json's own "imports" field instead,
// which maps "#*" to "./*" (the repo root, for local dev against .ts
// source via tsx/vitest). A consumer who npm-installs this package only
// ever sees dist/ (see package.json's own "files" list) — Node still walks
// up to the nearest package.json it can find, which is dist/'s own,
// *if one exists there*. Without it, "#*": "./*" resolves relative to the
// installed package's root, i.e. <pkg>/core/foo.js, which was never
// published — ERR_MODULE_NOT_FOUND. Writing a package.json here gives
// dist/ its own boundary, so the exact same "#*": "./*" specifier
// resolves relative to dist/ instead: dist/core/foo.js, which is real.
import { writeFileSync } from 'node:fs'

writeFileSync(
  'dist/package.json',
  JSON.stringify({ type: 'module', imports: { '#*': './*' } }, null, 2) + '\n',
)
