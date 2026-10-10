import { downloadCdn, localCdnDir } from './cdn.js';

// Runs once before the browser tests. Without a local Building Blocks build,
// downloads the pinned release into tests/e2e/.cdn-cache so every worker
// serves the same verified files.
export default async function globalSetup() {
    if (localCdnDir()) return;
    await downloadCdn();
}
