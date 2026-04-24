import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const rootDir = path.resolve(__dirname);

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['styled-jsx/babel'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': rootDir,
      'next/link': path.resolve(rootDir, 'src/shims/next-link.jsx'),
      'next/navigation': path.resolve(rootDir, 'src/shims/next-navigation.js'),
      'next/dynamic': path.resolve(rootDir, 'src/shims/next-dynamic.jsx'),
      'next/script': path.resolve(rootDir, 'src/shims/next-script.jsx'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
