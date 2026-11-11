// The one owned, public fixture approved for positive Atlas qualification.
// Keeping it compiled in means a typo or a third-party URL cannot silently
// turn the release gate into an arbitrary live-capture test.
export const APPROVED_FIXTURE_URL = "https://awwwards-mcp.vercel.app/";

export function normalizeFixtureUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid --fixture-url: ${raw}`);
  }
  const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
  const normalized = `${parsed.origin}${path}`;
  if (normalized !== APPROVED_FIXTURE_URL || parsed.search || parsed.hash) {
    throw new Error(
      `--fixture-url must be the approved fixture ${APPROVED_FIXTURE_URL}; refusing ${raw}`,
    );
  }
  return APPROVED_FIXTURE_URL;
}
