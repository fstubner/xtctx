import { defineConfig } from "vite";
import { resolve } from "node:path";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
});
