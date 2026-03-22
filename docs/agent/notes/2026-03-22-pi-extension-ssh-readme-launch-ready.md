# pi-extension-ssh README launch-ready pass

## Goal
Upgrade the public README for `pi-extension-ssh` so it feels launch-ready and communicates value faster to external users.

## Context
The package was already public, tested, and released, but the README was still more technical than launch-oriented. The next step was to improve positioning and packaging quality without changing runtime behavior.

## Decisions
- Added badges for CI, release, and license.
- Reframed the opening copy around the product value instead of only technical features.
- Added a stronger “why this exists” section comparing plain `ssh` versus Pi remote operations mode.
- Added a quick-start section.
- Added commercial / real-world use cases.
- Kept the enterprise controls explicit in the README to support the package positioning.

## Commands run
- `npm test`
- `git diff --check`

## Files changed
- `README.md`
- `docs/agent/notes/2026-03-22-pi-extension-ssh-readme-launch-ready.md`

## Tests
- `npm test`: OK
- `git diff --check`: OK

## Risks
- README now positions the package more strongly as an operations package, so future product direction should stay consistent with that framing.

## Next
- Optionally add screenshots or animated terminal demos.
- Optionally add sample `.pi/ssh/config.json` files under `examples/`.
