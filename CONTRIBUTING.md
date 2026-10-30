# Contributing to StormSignal

Help make weather evidence easier to understand. Small, reviewable changes with clear validation are welcome.

1. Open an issue describing the user problem or data gap. Never include private coordinates, contact details, tokens or personal emergency information.
2. Fork the repository and create a topic branch. Run `npm ci` with Node.js 22.12+.
3. Implement the change with accessible labels, keyboard behavior and clear failure states.
4. Add tests for the behavior that could regress. Run `npm test` and `npm run build`.
5. For map/provider changes, test real responses within provider limits. Record the date, region, source and actual checks in your pull request. Include screenshots for UI changes, without personal data.

## Data and safety standards

- Use primary provider documentation; retain required attribution and explain permitted use.
- Keep observation/capture time, forecast valid time and fetch time distinct.
- Handle missing values, stale data, unavailable coverage, cancelled/expired alerts and provider outages explicitly.
- Never label a location safe because no warning was returned. Do not promote heuristic model thresholds to official warnings.
- Preserve an authority's warning instructions and source link. Do not invent alert boundaries, emergency numbers, shelters, routes or evacuation orders.
- Never embed a secret in client code, a URL, a test fixture or a screenshot.
- Keep model disagreement distinct from a calibrated probability or ensemble confidence interval.
- Obtain and document a coverage source before adding a country to automatic official-alert coverage.

## Meaningful history

Use accurate author information, real commit timestamps and descriptions of work actually completed. Keep commits focused and retain third-party license notices. Do not manufacture contributor activity or misrepresent authorship. Tools used for development do not override these requirements.

## Helpful contributions

- Licensed, verifiable official-alert adapters for additional regions.
- Accessible text alternatives and translated preparedness content reviewed against local official sources.
- Tests for timezone boundaries, partial API failures, stale frames and alert expiry.
- Better caching and measured performance without concealing data age.
- Documentation that distinguishes tested support from future plans.

For security concerns, follow [SECURITY.md](SECURITY.md) instead of posting exploitable details in a public issue.
