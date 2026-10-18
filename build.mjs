/**
 * Build the published artifacts.
 *
 * The package's `main`/`exports` point at `lib/index.js` so a DSH installation that
 * loads built packages (rather than tsx running `src/`) can import it. `src/` stays
 * in the checkout for development and for tsx-based source runs.
 *
 * Runtime dependencies stay external: the harness supplies `@deepseek-ai/cordis`
 * (a peer) and the profile supplies `undici`.
 *
 * Usage:
 *   node build.mjs                      bundle `src/` into `lib/index.js`
 *   node build.mjs --fix-declarations   rewrite `.ts` specifiers in emitted `lib/types`
 */
import { build } from 'esbuild'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Rewrite relative `./x.ts` specifiers to `./x.js` in emitted declarations.
 *
 * `tsc` keeps the source extension in `.d.ts` output, but a consumer resolving this
 * package's types has no compiler option that accepts a `.ts` specifier, while the
 * emitted `.js` sibling is what actually exists.
 *
 * @param dir - the declaration output directory.
 */
function rewriteDeclarationSpecifiers(dir) {
  if (!existsSync(dir)) {
    throw new Error(`declaration output is missing: ${dir} (did tsc run?)`)
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      rewriteDeclarationSpecifiers(path)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const source = readFileSync(path, 'utf8')
    const rewritten = source.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
    if (rewritten !== source) writeFileSync(path, rewritten)
  }
}

if (process.argv.includes('--fix-declarations')) {
  rewriteDeclarationSpecifiers('lib/types')
} else {
  rmSync('lib', { recursive: true, force: true })

  await build({
    entryPoints: ['src/index.ts'],
    outfile: 'lib/index.js',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    bundle: true,
    sourcemap: true,
    // Bundling would duplicate the harness's Cordis Context and undici instance.
    external: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'undici'],
    logLevel: 'info',
  })
}
