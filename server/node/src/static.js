import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { notFound } from './errors.js';

const NO_VANILLA = [
    'The Starter CRM server is running, but there is no front-end to serve yet.',
    '',
    'Vanilla (no build step): the files in vanilla/ at the starter root are served here.',
    'React: cd react && npm install && npm run dev, then open http://localhost:5173/react/',
    '',
    'See README.md at the starter root.'
].join('\n');

const NO_REACT = [
    'The React app has not been built yet.',
    '',
    'Build it to serve it here:  cd react && npm install && npm run build',
    'Or run its dev server:      cd react && npm run dev, then open http://localhost:5173/react/'
].join('\n');

// Serves one front-end folder. Paths that match no file fall back to
// index.html for page loads, so client-side routes survive a reload.
export function frontEnd(dir, missingText) {
    const router = express.Router();
    router.use(express.static(dir));
    router.get('/{*path}', (req, res, next) => {
        const index = path.join(dir, 'index.html');
        if (!fs.existsSync(index)) {
            return res.type('text/plain').send(missingText + '\n');
        }
        if ((req.get('accept') || '').includes('text/html')) {
            return res.sendFile(index);
        }
        return next();
    });
    router.use(notFound);
    return router;
}

// The ES modules the no-build front-end imports. Files only: no index page,
// no listing and no fallback, so a missing module is a plain 404. A backslash
// is a path separator on Windows alone, so it is refused everywhere.
export function sharedModules(dir) {
    const router = express.Router();
    router.use((req, res, next) => (/\\|%5c/i.test(req.path) ? notFound(req, res) : next()));
    router.use(express.static(dir, { index: false, redirect: false }));
    router.use(notFound);
    return router;
}

export function staticRoutes(config) {
    const router = express.Router();
    router.use('/shared', sharedModules(path.join(config.root, 'shared')));
    router.use('/react', frontEnd(path.join(config.root, 'react', 'dist'), NO_REACT));
    router.use(frontEnd(path.join(config.root, 'vanilla'), NO_VANILLA));
    return router;
}
