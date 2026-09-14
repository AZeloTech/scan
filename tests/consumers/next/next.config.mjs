/**
 * A static export, because that is what the public site is. It is the harder of
 * the two consumers: no server, no headers, and webpack's own rules about which
 * dynamic imports it will emit a chunk for.
 */
export default {
  output: "export",
  reactStrictMode: true,
  images: { unoptimized: true },
};
