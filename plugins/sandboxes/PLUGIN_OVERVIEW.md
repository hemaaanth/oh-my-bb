# Sandboxes

Native BB machine and environment adapters for Daytona, Modal, E2B, Box, Freestyle. BB owns enrollment, checkout, suspension, resume and retirement. Sandboxes owns each provider adapter and retains legacy cleanup records until removal is confirmed.

Configure static credentials in native Configuration. Preferences controls defaults and local-editor behavior. Optional Credentials, Catalog, Agents and Projects call paths are off on new installs. Browser owns its separate Sandboxes opt-in. This package's managed-model runtime requires Model Gateway; it does not provide a local-login fallback.

The image pipeline requires an explicit supported builder and registry. Browser runtime archives carry reviewed source, input and archive hashes. Manual selection of older images and project-specific image pins are retired. Existing machines and provider defaults remain intact. Build provenance and existing-install imports are documented in CONTRACTS.md.

No provider account, private builder or application configuration is bundled. Offline tests do not certify cloud lifecycle. The unused broken standalone Freestyle snapshot publisher is not shipped; native snapshot selection remains.
