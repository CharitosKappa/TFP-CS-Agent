import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * Entra ID (Azure AD) SSO for the review dashboard. Stateless JWT sessions (no
 * DB adapter) so the middleware stays edge-safe. Reviewer identity comes from
 * the verified session, never from env.
 *
 * Required env: AUTH_SECRET, AUTH_MICROSOFT_ENTRA_ID_ID,
 * AUTH_MICROSOFT_ENTRA_ID_SECRET, AUTH_MICROSOFT_ENTRA_ID_ISSUER
 * (https://login.microsoftonline.com/<tenant-id>/v2.0).
 * Optional: ALLOWED_REVIEWERS (comma-separated email allowlist).
 */

/** Comma-separated allowlist; empty means "any user in the Entra tenant". */
function allowedReviewers(): string[] {
  return (process.env.ALLOWED_REVIEWERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
    }),
  ],
  callbacks: {
    // Used by the middleware to gate protected routes.
    authorized({ auth: session }) {
      return !!session?.user;
    },
    // Enforce the reviewer allowlist at sign-in.
    async signIn({ profile, user }) {
      const allow = allowedReviewers();
      if (allow.length === 0) return true;
      return allow.includes(emailFromProfile(profile, user));
    },
    // Entra work/school accounts often expose the address only as
    // `preferred_username`, not `email` — persist a stable, lowercased email on
    // the token so requireReviewer()/the header always see one.
    async jwt({ token, profile, user }) {
      if (profile || user) {
        const email = emailFromProfile(profile, user) || token.email || "";
        if (email) token.email = email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email;
      }
      return session;
    },
  },
});

function emailFromProfile(profile: unknown, user: unknown): string {
  const p = (profile ?? {}) as Record<string, unknown>;
  const u = (user ?? {}) as Record<string, unknown>;
  for (const c of [p.email, p.preferred_username, u.email]) {
    if (typeof c === "string" && c) return c.toLowerCase();
  }
  return "";
}
