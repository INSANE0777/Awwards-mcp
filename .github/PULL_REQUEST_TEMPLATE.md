## What changed

<!-- One paragraph: what this PR does and why. Link the issue: Closes #123 -->

## Type of change

- [ ] Bug fix (non-breaking, fixes an issue)
- [ ] New feature (non-breaking, adds functionality)
- [ ] Parser update (live markup drifted; includes fresh fixture)
- [ ] Docs / agent-setup guide
- [ ] Breaking change (fix or feature that changes existing tool behavior)

## Politeness & dependency constraints

- [ ] No new network paths outside `AwwwardsClient` (1 req/s, robots.txt-compliant)
- [ ] No new runtime dependencies (MCP SDK + zod stay the only ones; playwright/ffmpeg remain optional)
- [ ] No test touches the network

## How I tested it

```
npm run typecheck
npm test
```

<!-- For parser PRs: which fixture proves it? For features: which tests cover it? -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (or docs-only PR with no src/test changes)
- [ ] Bug fixes and parser updates come with a fixture-backed test
- [ ] Commit messages follow the repo style (`fix:` / `feat:` / `docs:` / `chore:` / `test:`)
