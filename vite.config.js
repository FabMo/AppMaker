import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import MonacoEditorPlugin from 'vite-plugin-monaco-editor'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import fs from 'fs'

const targets = [
  { src: 'app.json', dest: '.' },
  { src: 'package.json', dest: '.' }
]
if (fs.existsSync('assets')) targets.push({ src: 'assets', dest: '.' })

export default defineConfig({
  base: './',
  plugins: [
    react(),
    MonacoEditorPlugin({
      // we only need the base editor worker
      languageWorkers: ['editorWorkerService']
    }),
    viteStaticCopy({ targets })
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'js/bundle.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) return 'css/style.css'
          return 'assets/[name][extname]'
        }
      }
    }
  }
})
