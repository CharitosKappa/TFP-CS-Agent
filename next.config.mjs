/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep native/server-only deps out of the bundler.
  serverExternalPackages: ["@prisma/client", "@azure/msal-node", "sharp"],
};

export default nextConfig;
