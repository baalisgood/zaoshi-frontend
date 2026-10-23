# Frontend design workspace

This is a standalone UI demo, with synthetic browser-only data. Preserve route coverage and responsive/light/dark behavior. UI files live in components/ and app/globals.css. Keep network access local and fail closed for unknown API routes. Do not introduce backend services, secrets, real customer data, production destinations or payment/auth integrations. Never replace the real application's backend or package lock with these demo shims. Validate with npm run build and inspect the affected routes in a real browser before handoff.
