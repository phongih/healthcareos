// Build tĩnh: dist/{index.html, portal.html, app-<hash>.js, app-<hash>.css}. Không script/style inline (CSP chặt: script-src 'self').
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const out = new URL('./dist/', import.meta.url).pathname;

/** Một trang = một entry + một file CSS + một HTML. Tên file dạng app-<hash>.(js|css) để Caddy cache lâu (cùng quy tắc). */
const PAGES = [
  { entry: 'src/main.tsx', css: 'src/styles.css', html: 'index.html' },
  // HCOS-F20: cổng bệnh nhân — bundle riêng, nhẹ (không OIDC, không màn hình nhân viên).
  { entry: 'src/portal-main.tsx', css: 'src/portal.css', html: 'portal.html' },
];

async function once() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const p of PAGES) {
    const r = await esbuild.build({
      entryPoints: [p.entry],
      bundle: true,
      minify: !watch,
      sourcemap: watch ? 'inline' : false,
      format: 'esm',
      target: ['es2022'],
      jsx: 'automatic',
      write: false,
      define: {
        'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
        // Dải cảnh báo môi trường (vd. thực tập). Rỗng = không hiện. Đặt lúc build: HCOS_ENV_LABEL="..." npm run build
        __HCOS_ENV_LABEL__: JSON.stringify((process.env.HCOS_ENV_LABEL ?? '').slice(0, 200)),
      },
      legalComments: 'none',
    });
    const js = r.outputFiles[0].contents;
    const css = readFileSync(p.css);
    const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
    const jsName = `app-${h(js)}.js`;
    const cssName = `app-${h(css)}.css`;
    writeFileSync(out + jsName, js);
    writeFileSync(out + cssName, css);
    const html = readFileSync(p.html, 'utf8').replace('%APP_JS%', jsName).replace('%APP_CSS%', cssName);
    writeFileSync(out + p.html, html);
    console.log(`${p.html}: ${jsName} (${(js.length / 1024).toFixed(0)} KiB), ${cssName}`);
  }
}

await once();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let t;
  fsWatch('src', { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => once().catch((e) => console.error(e.message)), 150); });
  console.log('watching src/ …');
}
