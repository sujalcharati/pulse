/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile our workspace package so Next.js can import it from
  // packages/sdk without a separate build step.
  transpilePackages: ["@pulse/sdk"],
  // The pg driver pulls in optional native bindings (pg-native) we
  // don't need; mark them external to avoid bundling.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
