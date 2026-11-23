import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("./dist/", import.meta.url);
await mkdir(output, { recursive: true });

for (const entry of ["server", "worker"]) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`./src/${entry}.ts`, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "external",
    write: false,
  });
  await writeFile(new URL(`${entry}.mjs`, output), result.outputFiles[0].contents);
}

await cp(new URL("./migrations/", import.meta.url), new URL("migrations/", output), { recursive: true });
await cp(new URL("./src/dashboard/", import.meta.url), new URL("dashboard/", output), { recursive: true });

const tokens = JSON.parse(
  await readFile(new URL("./src/dashboard/design-tokens.json", import.meta.url), "utf8"),
);

const tokenMap = {
  "surface-base": "base",
  "surface-raised": "raised",
  "text-main": "text",
  "text-muted": "muted",
  border: "line",
  accent: "accent",
  "surface-accent": "tint",
  danger: "danger",
  shadow: "shadow",
};

const vars = (theme) =>
  Object.entries(tokenMap)
    .map(([key, name]) => `--${name}:${tokens[theme][key]};`)
    .join("");

const baseCss = await readFile(new URL("./src/dashboard/app.css", import.meta.url), "utf8");
const css = `:root{${vars("light")}}@media(prefers-color-scheme:dark){:root{${vars("dark")}}}\n${baseCss}`;
await writeFile(new URL("dashboard/app.css", output), css);

console.log("Built xtctx-cloud server, worker, migrations, and dashboard assets");
