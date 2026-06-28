export { auth as middleware } from "@/auth";

export const config = {
  // Gate the dashboard and its Server Action POSTs. Machine routes
  // (/api/ingest, /api/process, the Graph webhook) are guarded by an internal
  // secret instead, and /api/auth/* is the sign-in flow itself.
  matcher: ["/", "/review/:path*", "/followups"],
};
