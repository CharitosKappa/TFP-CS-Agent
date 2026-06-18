import { auth } from "@/auth";

/**
 * Returns the signed-in reviewer's email, or throws if there is no valid
 * session. Called at the top of every Server Action as defense-in-depth on top
 * of the route middleware, and as the single source of reviewer identity.
 */
export async function requireReviewer(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    throw new Error("Δεν υπάρχει ενεργή συνεδρία ελεγκτή — συνδεθείτε ξανά.");
  }
  return email;
}
