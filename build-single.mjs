// build-single.mjs — stitch public/* into one shareable HTML file.
// Mechanical inliner: replaces <link rel="stylesheet" href="X"> with <style>
// and <script src="X"></script> with inline <script>, in document order.
// Run:  node build-single.mjs   → writes dist/showrunner-single.html
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'public');
let html = readFileSync(join(root, 'index.html'), 'utf8');

// Inline local stylesheets (leave remote/absolute URLs e.g. Google Fonts alone)
html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
  const m = tag.match(/href=["']([^"']+)["']/i);
  if (!m || /^https?:|^\/\//i.test(m[1])) return tag;
  const css = readFileSync(join(root, m[1]), 'utf8');
  return `<style>\n/* inlined: ${m[1]} */\n${css}\n</style>`;
});

// Inline local scripts, preserving order
html = html.replace(/<script\s+[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (tag, src) => {
  if (/^https?:|^\/\//i.test(src)) return tag;
  let js = readFileSync(join(root, src), 'utf8');
  js = js.replace(/<\/script/gi, '<\\/script'); // safety: never break the wrapper tag
  return `<script>\n/* inlined: ${src} */\n${js}\n</script>`;
});

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'dist');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'showrunner-single.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
