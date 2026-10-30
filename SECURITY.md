# Security

StormSignal's current architecture is a static browser application using public data endpoints. It does not need provider secrets. No vulnerability response SLA is promised.

## Reporting

Use GitHub's **Security → Report a vulnerability** for this repository if private vulnerability reporting is enabled. If that option is unavailable, open an issue requesting a private reporting channel **without including exploit details, secrets, private coordinates or personal data**. Do not publish a working exploit or sensitive logs before the maintainer has a safe reporting channel.

For an inaccurate active warning, contact the issuing weather authority and follow its current guidance; repository maintainers do not control official alerts or emergency response.

## Maintainer checklist

- Review dependency advisories and pin reproducible installs with `package-lock.json`.
- Render provider text as text, not HTML. Validate external links and enforce HTTPS.
- Bound provider response sizes, request duration, retries and cache age.
- Validate persisted local data and handle storage being disabled or full.
- Do not cache private data or third-party map tiles in a service worker without reviewing their terms.
- Do not put secret keys in `VITE_*` variables; they are public client code.
- Recheck provider terms and permissions before introducing telemetry, push subscriptions, paid APIs or a server.
- Use a Content Security Policy appropriate to the actual hosting environment and required providers. Avoid weakening a host policy without a concrete need.

Report only tests actually run. A passing build or unit-test suite is not a security audit or certification for use in emergencies.
