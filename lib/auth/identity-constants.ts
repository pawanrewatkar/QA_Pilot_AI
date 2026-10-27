/**
 * Owner id of the single local operator (local development, no sign-in). It contains a colon, so it can
 * never collide with a Supabase Auth user id (a UUID). Data created before ownership existed is assigned to
 * it by migration 7 and can later be reassigned to the operator's real account.
 */
export const LOCAL_OWNER_ID = "local:default";
