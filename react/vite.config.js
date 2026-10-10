import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const shared = fileURLToPath(new URL('../shared', import.meta.url));

// The starter server (server/node or server/python) owns every route that
// touches a credential. In development Vite forwards those to it, so the
// browser sees one origin, exactly as it does in production.
const SERVER = 'http://127.0.0.1:8080';

export default defineConfig({
    // The starter server serves the built app under /react/.
    base: '/react/',
    plugins: [react()],
    resolve: {
        alias: { '@shared': shared }
    },
    server: {
        port: 5173,
        strictPort: true,
        fs: { allow: ['..'] },
        proxy: {
            '/api': SERVER,
            '/__dev': SERVER,
            '/shared': SERVER,
            '/webhooks': SERVER
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.jsx'],
        setupFiles: ['src/test/setup.js']
    }
});
