"use client";

import dynamic from "next/dynamic";

// The library touches the camera and WebAssembly, so it has no business running
// during a static export's prerender. `ssr: false` is exactly how a real host
// would mount it, which makes it part of what this smoke test proves.
const SmokeApp = dynamic(() => import("../../shared-smoke-app.jsx"), { ssr: false });

export default function Page() {
  return <SmokeApp />;
}
