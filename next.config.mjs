/** @type {import('next').NextConfig} */
const nextConfig = {
  // Orchestrator runs on the Node runtime (Neon serverless driver + AI SDK).
  serverExternalPackages: ["@neondatabase/serverless"],
};

export default nextConfig;
