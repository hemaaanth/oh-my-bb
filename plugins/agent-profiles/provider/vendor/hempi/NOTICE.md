# Third-party attribution

OMP components adapted from https://github.com/can1357/oh-my-pi at tag v18.4.2, commit 4620bb8. Licensed under MIT; the complete upstream license is in OMP-LICENSE.

- src/emission-guard.ts: copied packages/coding-agent/src/advisor/emission-guard.ts.
- prompts/advisor.md: copied packages/coding-agent/src/prompts/advisor/system.md; runtime supplies the note budget and Pi capability restrictions.
- src/safety.ts: output-only hazard/provenance checks adapted from advisor/runtime.ts.
- src/ui.ts: rounded inline panel adaptation originally developed against OMP's overlay-box, ask-dialog and BTW panel, using Pi TUI components.

Hempi's original runtime integration, broker delegation, configuration/profiles, lifecycle handling and tests use public Pi APIs. This package is not OMP and does not claim binary or configuration compatibility with all OMP features.

## OptChat

`src/optchat/` is copied and adapted from https://github.com/jonaslsaa/pi-optchat at commit `924e61f97543383e72691442c944e12dbd14b9d7`. The original implementation code is MIT licensed. The complete upstream license is in `OPTCHAT-LICENSE`.

The OptChat memory design and adapted prompt text in `src/optchat/prompts.ts` come from Victor Taelin's publicly shared recipe: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449.

That text is credited to Victor Taelin. It is not relicensed by pi-optchat's MIT grant for original implementation code. The complete recipe is linked upstream.

## Local Agents distribution

The upstream paragraphs above record implementation and design provenance. The excluded attributed core runtime prompt wording has been replaced with original contract-derived text for Agents; it is not included or relicensed here. `LOCAL_PATCH.md` records the exact patch, unchanged upstream base, and source hashes. Existing run-policy adapters and the memory implementation remain unchanged. The owner confirms Hempi is their own app and authorizes public MIT publication of owned code, recorded in `LICENSE`. That grant does not relicense excluded upstream text or replace separate implementation/helper notices.
