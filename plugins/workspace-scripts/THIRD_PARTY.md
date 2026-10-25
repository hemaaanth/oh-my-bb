# Third-party components

## BB shared UI

`components/`, `lib/`, and `hooks/` originate from BB's MIT-licensed plugin UI
registry, configured in `components.json`. The icon wrapper uses the public
Plugin SDK renderer instead of bundling an icon library.

`icons/scripts.svg` is package-owned terminal artwork, under this package's MIT
license. The manifest and static UI use that same SVG.

## Optional downloaded security tools

These are not included in the package. The standalone security recipe downloads
them to a supported Linux host. Version pins, URLs and SHA-256 checksums live in
`recipes/security-tools/versions.json`. Semgrep uses a pinned uv package version.

- [Gitleaks](https://github.com/gitleaks/gitleaks): MIT.
- [Nuclei](https://github.com/projectdiscovery/nuclei): MIT.
- [Nuclei templates](https://github.com/projectdiscovery/nuclei-templates): MIT.
- [OSV-Scanner](https://github.com/google/osv-scanner): Apache-2.0.
- [Semgrep](https://github.com/semgrep/semgrep): LGPL-2.1 engine; its rule packs
  have separate terms. Scripts does not download Semgrep rule packs or run scans.

Downloaded tools retain their own licenses and upstream behavior. Scripts
performs no model calls or hosted scanning. Downloading and running these tools
uses the host's network and local resources.
