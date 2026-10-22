const result = await Bun.build({
  entrypoints: ['./src/console/crypto.ts'],
  outdir: './src/console/assets',
  naming: 'crypto.js',
  target: 'browser',
  minify: true,
});
if (!result.success) throw new Error(result.logs.join('\n'));
console.log('NStack browser crypto built from locked dependencies');
