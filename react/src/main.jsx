import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@shared/crm.css';
import { startCrm } from '@shared/crm.js';
import { getThemeChoice } from '@shared/settings.js';
import { applyThemeChoice, syncWidgetTheme } from '@shared/ui.js';
import { App } from './App.jsx';
import { ErrorNotice } from './components/Notice.jsx';
import { SignIn } from './components/SignIn.jsx';
import { CrmContext } from './crm-context.js';

// "/react" in the built app. The router and the sign-in redirect both need it.
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '');

// The CRM and the Drop Cowboy widgets switch between light and dark together,
// starting from the theme this browser chose.
applyThemeChoice(document.documentElement, getThemeChoice());
syncWidgetTheme(document.documentElement);

const root = createRoot(document.getElementById('root'));

startCrm({ basePath: BASE_PATH }).then(
    (crm) => {
        // Back from sign-in: return to the page the user signed in from.
        if (crm.returnTo) {
            window.history.replaceState(null, '', crm.returnTo);
        }
        // Your own server's identity says nobody is signed in: show the sign-in
        // screen instead of an app whose every request would be refused.
        if (crm.config.auth_mode === 'server' && crm.needsSignIn()) {
            root.render(<StrictMode><SignIn crm={crm} /></StrictMode>);
            return;
        }
        root.render(
            <StrictMode>
                <CrmContext value={crm}>
                    <BrowserRouter basename={BASE_PATH}>
                        <App />
                    </BrowserRouter>
                </CrmContext>
            </StrictMode>
        );
    },
    (err) => root.render(<main id="main"><ErrorNotice error={err} full /></main>)
);
