# Rename Plan: Oobee → A11y Assist

Working branch: `rename-oobee-to-a11y-assist`

## Naming conventions (agreed with user)

| Context | From | To |
|---------|------|-----|
| Code identifier (any case) | `oobee` | `a11yassist` |
| snake_case rule/name | `oobee_accessible_label` | `a11yassist_accessible_label` |
| kebab-case rule/CSS class | `oobee-accessible-label`, `.oobee-btn` | `a11yassist-accessible-label`, `.a11yassist-btn` |
| camelCase | `oobeeAppVersion` | `a11yassistAppVersion` |
| PascalCase | `OobeeScanOptions` | `A11yassistScanOptions` |
| SCREAMING_SNAKE (env var) | `OOBEE_VERBOSE` | `A11Y_ASSIST_VERBOSE` |
| Display string | `"Oobee"` | `"A11y Assist"` |
| URL slug / npm package | `oobee` / `@govtechsg/oobee` | `a11y-assist` / `@govtechsg/a11y-assist` |
| Home dir path | `.oobee/`, `Oobee/` | `.a11yassist/`, `A11y Assist/` |

## Decisions

- **Full rename** — no backwards compatibility for env vars or rule IDs.
- **CLI command** renamed from `oobee` to `a11y-assist`.
- **GitHub URL and npm package** renamed to `a11y-assist`.
- **Storage paths** renamed (breaks existing installs' cached data).

## Stages (each stage = one commit + push)

1. **[cfg]** package.json, Dockerfile, CI workflows, .dockerignore, gitlab-pipeline-template.yml
2. **[env]** Rename OOBEE_* environment variables in src/
3. **[rules]** Rename accessibility rule IDs oobee-* → a11yassist-* in src/
4. **[code]** Rename code identifiers/types in src/
5. **[strings]** Update string literals "Oobee" → "A11y Assist" in src/
6. **[paths]** Rename storage/config directory paths in src/
7. **[html]** Rename CSS classes, HTML IDs, window.oobee → window.a11yassist
8. **[files]** Rename source files (src/constants/oobeeAi.ts, generateOobeeClientScanner.ts, etc.)
9. **[examples]** Rename example files, directories, and their internal refs
10. **[scripts]** Rename script files (scripts/install_oobee_*, oobee_shell.*)
11. **[docs]** Update all .md documentation files
12. **[types]** Run tsc, fix any remaining type errors
13. **[final]** Rename the top-level `oobee-client-scanner.js` bundle if needed

## Resumability notes

If context is lost mid-run, check:
- `git log` on branch `rename-oobee-to-a11y-assist` for last completed stage.
- `git status` for uncommitted changes.
- `grep -ri 'oobee' src/ --include='*.ts' | wc -l` to gauge remaining src/ references.
- `find . -name '*oobee*' -not -path './node_modules/*' -not -path './.git/*' -not -path './dist/*' -not -path './results/*'` for remaining renamed files.

Resume from the next incomplete stage per the stage list above.
