import { createContext, useContext } from 'react';

/**
 * The object startCrm() returns: config, tokens, contacts API, CDN loader,
 * activity log. Created once in main.jsx, before the first render.
 * @type {import('react').Context<Awaited<ReturnType<typeof import('@shared/crm.js').startCrm>> | null>}
 */
export const CrmContext = createContext(null);

export function useCrm() {
    return useContext(CrmContext);
}
