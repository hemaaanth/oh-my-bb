# Pinpoint

Point at a live page and send reviewable visual feedback to BB agents.

## Point, ask, and review

Pick an element, select text, or edit rendered copy. Pinpoint keeps the page location, conversation, optional screenshot, and review state. Agents report changes as ready. You approve or reply with more feedback. Text edits retain an explicit confirmation step.

Open Pinpoint from a thread's panel launcher. Native Configuration controls the default URL, review-chat routing, and immediate dispatch. More → Setup guide explains the workflow and privacy boundaries.

## Optional integrations

Pinpoint works without other Oh My BB packages. Explicit opt-ins under Oh My BB can use saved Agents profiles, Provider Usage capacity checks, and Clasi learning. No integration is probed, installed, or enabled at startup.

Clasi learning requires both the global opt-in and approval of the exact text on an unchecked-by-default card. Approving the fix alone saves nothing to Clasi. Disabling blocks writes and retries without deleting existing choices.

## Private feedback

Source distribution does not publish comments, screenshots, settings, or approvals. Shared-review consumers own guest authentication, scope, expiry, CSRF, and allowed actions. Guest learning approval is not accepted by the standalone client.

Guest comments wait in a separate Guest feedback view. The owner can edit the pending text before approving it for agent processing with the checkmark. Later guest comments wait for fresh owner approval. Agent feedback counts only finished agent work awaiting review. Sharing and global immediate dispatch do not grant guest agent, completion, or learning authority. Guest controls are limited to capture, reply, and deletion of their own feedback before owner adoption.

Preview pages run in an opaque sandbox without BB login cookies. Actions requested inside the page need confirmation in BB. The resource bridge is limited to the selected app. Protected Connect URLs, sign-in flows, write APIs, and undeclared external services may not work. Older Session Share preview servers must adopt isolation contract version 1 before their embedded previews can load.

## Requirements

BB 0.46.1 or later. No required suite plugin, external account, or additional API key. The thread's configured agent may have its normal provider costs.
