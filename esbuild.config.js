const esbuild = require('esbuild');
const vuePlugin = require('esbuild-plugin-vue3');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// Ensure dist directories exist
const dirs = [
  'dist',
  'dist/content',
  'dist/background',
  'dist/popup',
  'dist/assets/icons',
];

dirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Copy static files
function copyStaticFiles() {
  // Copy CSS
  fs.copyFileSync('src/content/styles.css', 'dist/content/styles.css');
  fs.copyFileSync('src/popup/popup.css', 'dist/popup/popup.css');

  // Copy HTML
  fs.copyFileSync('src/popup/popup.html', 'dist/popup/popup.html');

  // Copy manifest
  fs.copyFileSync('manifest.json', 'dist/manifest.json');

  // Copy icons if they exist
  const iconSizes = [16, 32, 48, 128];
  iconSizes.forEach(size => {
    const iconPath = `assets/icons/icon${size}.png`;
    if (fs.existsSync(iconPath)) {
      fs.copyFileSync(iconPath, `dist/assets/icons/icon${size}.png`);
    }
  });

  console.log('Static files copied');
}

// Build configuration for each entry point
const builds = [
  {
    entryPoints: ['src/content/content.ts'],
    outfile: 'dist/content/content.js',
    format: 'iife',
  },
  {
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/background/service-worker.js',
    format: 'esm',
  },
  {
    entryPoints: ['src/ui/views/popup/main.ts'],
    outfile: 'dist/popup/vue_popup.js',
    format: 'iife',
  },
];

// Common build options
const commonOptions = {
  bundle: true,
  sourcemap: true,
  target: ['chrome100'],
  minify: !isWatch,
  plugins: [vuePlugin()],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    '__VUE_OPTIONS_API__': 'true',
    '__VUE_PROD_DEVTOOLS__': 'false',
  },
};

async function build() {
  try {
    copyStaticFiles();

    const contexts = await Promise.all(
      builds.map(config =>
        esbuild.context({
          ...commonOptions,
          ...config,
        })
      )
    );

    if (isWatch) {
      console.log('Watching for changes...');
      await Promise.all(contexts.map(ctx => ctx.watch()));

      // Watch static files too
      const staticFiles = [
        'src/content/styles.css',
        'src/popup/popup.css',
        'src/popup/popup.html',
        'manifest.json',
      ];

      staticFiles.forEach(file => {
        fs.watchFile(file, () => {
          console.log(`${file} changed, copying...`);
          copyStaticFiles();
        });
      });
    } else {
      await Promise.all(contexts.map(ctx => ctx.rebuild()));
      await Promise.all(contexts.map(ctx => ctx.dispose()));
      console.log('Build complete');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
