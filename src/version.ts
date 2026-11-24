// Replaced at build time (esbuild --define) so the bundled server needs no package.json beside it.
declare const __ARKIVIST_VERSION__: string | undefined
export const VERSION: string = typeof __ARKIVIST_VERSION__ === 'string' ? __ARKIVIST_VERSION__ : '0.0.0-dev'
