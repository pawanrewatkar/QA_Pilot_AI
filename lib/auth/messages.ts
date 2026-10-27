/** User-facing auth messages. Deliberately generic so they never reveal whether an account or allow-list entry exists. */
export const GENERIC = {
  signUp: "If this address is permitted to register, a confirmation email is on its way. Open the link in it to activate the account.",
  signIn: "The email or password is incorrect, or the account is not confirmed or not permitted.",
  reset: "If this address belongs to a permitted account, a password-reset email is on its way.",
  unavailable: "Sign-in is not available on this instance.",
  registrationClosed: "Registration is closed until an administrator configures the allowed email addresses (AUTH_ALLOWED_EMAILS).",
  tryLater: "The request could not be completed right now. Try again in a few minutes.",
} as const;
