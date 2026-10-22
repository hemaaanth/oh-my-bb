# BB component provenance

`popover`, `responsive-overlay`, `overlay-trigger`, and the media-query hooks
are copied without changes from BB's `desktop-v0.42.0` plugin registry,
matching the installed BB release. Their dependencies use this plugin's
existing `lib/utils` and plugin-scoped `lib/portal-scope` implementations.

Source: `packages/plugin-registry/r/<component>.json` in the upstream BB
repository. Update these components together when upgrading BB; preserve
responsive drawers, portal scoping, and focus handling.
