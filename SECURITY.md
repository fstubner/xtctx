# Security Policy

## Supported Versions

Security fixes are provided for the latest published `0.1.x` release line.

## Reporting a Vulnerability

Please report vulnerabilities privately. Do not open a public issue.

Preferred reporting path:

1. Open a private GitHub security advisory for this repository.
2. Include:
   - Impact summary
   - Reproduction steps or PoC
   - Affected versions/paths
   - Suggested remediation (if known)

## Response Expectations

- Initial acknowledgment target: within 72 hours
- Triage and severity assessment: as soon as reproducible details are available
- Fix and coordinated disclosure timing: based on severity and exploitability

## Disclosure

Please allow maintainers reasonable time to investigate and patch before public disclosure.

## Release Pipeline Security

- npm publishing is intended to run through GitHub OIDC trusted publishing.
- Do not share or request long-lived npm auth tokens for this repository.
- If release automation, provenance, or workflow permissions appear misconfigured, report privately using the same vulnerability process above.

## Security Baseline Tracking

- The project maintains an OWASP ASVS-lite checklist at `docs/security/owasp-asvs-lite.md`.
- CI validates security tests and checklist presence on each push/PR.
