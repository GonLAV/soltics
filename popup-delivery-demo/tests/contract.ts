// The contract the portable tests depend on.
//
// Everything here is overridable by env var, so the same specs can run against
// the local mock or a real environment without editing test code.
//
// Against a real platform you will typically set:
//   BASE_URL             https://staging.your-site.com
//   URL_NON_ELIGIBLE     however that environment addresses a user outside the audience
//   POPUP_TEXT           the copy of the campaign under test

export const SCENARIOS = {
  // A user the campaign engine is expected to trigger for.
  eligible: process.env.URL_ELIGIBLE ?? '/',

  // A user the engine is expected to decline. On the mock this is a test query
  // param; on a real environment it is whatever that environment offers —
  // a seeded account, a segment-excluded user, or a staging harness flag.
  nonEligible: process.env.URL_NON_ELIGIBLE ?? '/?testUser=non-eligible',
};

// Text that must appear in the delivered popup.
export const POPUP_TEXT = process.env.POPUP_TEXT ?? 'Special Offer';

// How long to allow for the full REST → decision → WebSocket → render chain.
export const DELIVERY_TIMEOUT = Number(process.env.DELIVERY_TIMEOUT_MS ?? 10_000);

// How long to wait before concluding that nothing was delivered.
export const NO_DELIVERY_TIMEOUT = Number(process.env.NO_DELIVERY_TIMEOUT_MS ?? 5_000);

// True when the suite is pointed at something other than the bundled mock.
export const IS_REMOTE = Boolean(process.env.BASE_URL);
