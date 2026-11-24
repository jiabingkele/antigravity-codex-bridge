import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "src");
const distDir = path.join(__dirname, "dist");
fs.mkdirSync(distDir, { recursive: true });

const jsResult = await esbuild.build({
  entryPoints: [path.join(srcDir, "app.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  write: false,
});

const cssResult = await esbuild.build({
  entryPoints: [path.join(srcDir, "styles.css")],
  bundle: true,
  minify: true,
  write: false,
});

const bundledJs = jsResult.outputFiles[0].text.replace(/<\/script>/gi, "<\\/script>");
const bundledCss = cssResult.outputFiles[0].text.replace(/<\/style>/gi, "<\\/style>");
const template = fs.readFileSync(path.join(srcDir, "template.html"), "utf8");

const finalHtml = template
  .replace("/*__INLINED_CSS__*/", () => bundledCss)
  .replace("/*__INLINED_JS__*/", () => bundledJs);

const outFile = path.join(distDir, "console.html");
fs.writeFileSync(outFile, finalHtml, "utf8");

const kb = (Buffer.byteLength(finalHtml, "utf8") / 1024).toFixed(1);
console.log(`Built ${outFile} (${kb} KiB)`);
