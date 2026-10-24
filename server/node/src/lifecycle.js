/**
 * Process lifecycle for graceful shutdown and readiness.
 *
 * Where it sits: createApp() builds one Lifecycle; /readyz reads it; SIGTERM
 * in index.js calls beginDrain() then exit. SSE streams register themselves
 * so drain can send `retry: 1000` and close each one.
 *
 * CONTRACT.md: GET /readyz, Shutdown.
 * Customers set DC_SHUTDOWN_GRACE_SECONDS; they should not edit this file.
 */

/**
 * What lifecycle needs from an open SSE response in order to close it.
 *
 * @typedef {object} StreamHandle
 * @property {() => void} close Write retry + end the SSE response.
 */

/**
 * Creates the shared lifecycle object attached to the Express app.
 *
 * @param {object} options Construction options.
 * @param {{ ready?: () => boolean|Promise<boolean> }} [options.store] The event
 *   store; its ready() feeds /readyz when present.
 * @param {number} options.shutdownGraceSeconds How long the entry point waits
 *   after beginDrain() before it exits (DC_SHUTDOWN_GRACE_SECONDS).
 * @returns {object} isDraining, addStream, checkReady, beginDrain, graceSeconds.
 */
export function createLifecycle({ store, shutdownGraceSeconds }) {
    let draining = false;
    /** The open SSE streams, so a drain can close each one. @type {Set<StreamHandle>} */
    const streams = new Set();

    return {
        /**
         * Whether the process is shutting down. /readyz returns 503 while true.
         * @returns {boolean} True once beginDrain() has run.
         */
        isDraining() {
            return draining;
        },

        /**
         * Register an open SSE response. Returns an unsubscribe function.
         * @param {StreamHandle} handle The stream to close on drain.
         * @returns {() => void} Call it when the stream ends on its own.
         */
        addStream(handle) {
            streams.add(handle);
            return () => streams.delete(handle);
        },

        /**
         * Cheap readiness: not draining, and the store (when it exposes ready)
         * reports healthy. Phase 1's memory store is always ready.
         * @returns {Promise<{ ok: boolean, reason?: string }>} `ok` false with a
         *   reason of `draining` or `store_not_ready` when traffic should stop.
         */
        async checkReady() {
            if (draining) return { ok: false, reason: 'draining' };
            if (store && typeof store.ready === 'function') {
                const ok = await store.ready();
                if (!ok) return { ok: false, reason: 'store_not_ready' };
            }
            return { ok: true };
        },

        /**
         * Stop accepting work: mark draining, close SSE streams with a short
         * retry hint, then wait up to the grace period before the caller exits.
         *
         * Why close streams ourselves: server.close() waits for open connections,
         * and SSE never ends on its own, so deploys would hang until the host
         * SIGKILLs the process.
         *
         * @returns {Promise<void>} Resolves once every stream has been closed.
         */
        async beginDrain() {
            if (draining) return;
            draining = true;
            for (const handle of [...streams]) {
                try {
                    handle.close();
                } catch {
                    // Already closed.
                }
            }
            streams.clear();
        },

        /**
         * The configured grace period.
         * @returns {number} Seconds the entry point waits before exiting.
         */
        get graceSeconds() {
            return shutdownGraceSeconds;
        }
    };
}
