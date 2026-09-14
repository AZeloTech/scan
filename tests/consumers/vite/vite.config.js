import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// A consumer as ordinary as we can make it: default settings, one plugin.
// If the library needs special Vite configuration to work, that is a defect in
// the library, and this file is where it shows up.
export default defineConfig({
  plugins: [react()],
  base: "/",
});
