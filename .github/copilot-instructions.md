# GitHub Copilot Instructions for StormSignal

StormSignal is a weather situational awareness and evidence workspace built with React 19, TypeScript, Three.js, Vite, and Cloudflare Pages/Workers.

## Key Development Guidelines

1. **Safety & Data Integrity:**
   - Official alerts (NWS, SACHET/IMD, PAGASA, BMKG, WMO SWIC) must never be mocked as "all clear" or fabricated.
   - Missing data must be explicitly reported as missing or degraded; never invent values.

2. **Performance & Architectural Budgets:**
   - Keep initial load minimal. Three.js is strictly lazy-loaded via dynamic import on demand.
   - Maintain stylesheet budget (< 85 KB uncompressed).
   - In server code (`server/`), maintain bounded memory caches, bounded timeouts (8s), and request coalescing to adhere to Cloudflare Worker CPU limits.

3. **Accessibility (WCAG 2.1 AA):**
   - Ensure all interactive elements have 3:1 focus rings and contrast.
   - Maintain 4.5:1 text contrast on dark glass and aurora surfaces.
   - Support keyboard navigation (Tab, Arrow keys, Enter, Escape).

4. **Testing & Tooling:**
   - Run `npm test` and `npm run check` before submitting changes.
   - Enforce code style with `npm run format`.
