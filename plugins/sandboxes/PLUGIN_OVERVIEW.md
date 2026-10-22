Run cloud development machines with private browser desktops, previews and lifecycle cleanup.

Sandboxes adds Daytona, Modal, E2B, Box, Freestyle and Nirvana environments to BB.
BB owns thread attachment and machine retirement. Sandboxes owns provider setup,
images, optional private networking, idle policy and vendor cleanup.

## Getting started

Install Sandboxes from this marketplace. In Settings → Sandboxes, configure the
provider you want and its API credentials. Register a runtime image for that
provider before starting a sandbox thread. There is no bundled private registry
or account: use your own registry and build the supplied Docker image with
`bb sandbox build-image`, or register a compatible existing image with
`bb sandbox register-image --reference <image>`.

Select a Sandboxes environment when starting a BB thread. Use `bb sandbox doctor`
for missing configuration and version findings. Provider usage is billed by your
provider. Closing a browser does not retire its sandbox; BB retires the machine
after its last thread is archived.

## Optional integrations

Install Browser for isolated signed-in automation, live viewing and manual
handoff. Its two global settings control home routing and personal-login seeds.
The runtime image includes a pinned Browser CLI archive, so image builds do not
need a sibling Browser checkout. Updating that archive is a maintainer action.

Model Gateway can supply model routing. Projects, Project Environments, Catalog
and Agents can add credential profiles, approved skills and agent selections.
They are optional; missing integrations leave those choices empty. Scripts adds
its own item to BB's shared machine menu and does not depend on Sandboxes.

Private browser viewing uses an authenticated, expiring BB connection. It does
not expose a raw VNC port. Optional Tailscale SSH lets local editors reach a
sandbox without a public SSH listener. Browser routing and SSH retain separate
network identities, so one cannot silently reroute or stop the other.

Copying local GitHub CLI authentication is off on a fresh public installation.
Provider secrets stay in plugin storage. Model Gateway setup files contain
environment-variable references rather than account tokens.

## Current limits

Runtime images are Linux images. Provider allocation, idle behavior, regions,
quotas and resumability differ. Automated tests cover provider contracts;
real end-to-end browser acceptance was exercised with Daytona. Other providers
must be checked with their actual image and account before claiming equivalent
runtime behavior. See README.md for setup, CLI commands and provider details.
