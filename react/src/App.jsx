import { Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './components/Layout.jsx';
import { ToastProvider } from './components/Toasts.jsx';
import { CampaignsPage } from './pages/CampaignsPage.jsx';
import { ContactPage } from './pages/ContactPage.jsx';
import { ContactsPage, NewContactPage } from './pages/ContactsPage.jsx';
import { InboxPage } from './pages/InboxPage.jsx';
import { ModulePage } from './pages/ModulePage.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';
import { PhonePage } from './pages/PhonePage.jsx';
import { PipelinePage } from './pages/PipelinePage.jsx';
import { SetupPage } from './pages/SetupPage.jsx';

function Home() {
    const { search } = useLocation();
    return <Navigate to={'/contacts' + search} replace />;
}

export function App() {
    return (
        <ToastProvider>
            <Routes>
                <Route element={<Layout />}>
                    <Route index element={<Home />} />
                    <Route path="contacts" element={<ContactsPage />} />
                    <Route path="contacts/new" element={<NewContactPage />} />
                    <Route path="contacts/:id" element={<ContactPage />} />
                    <Route path="pipeline" element={<PipelinePage />} />
                    <Route path="inbox" element={<InboxPage />} />
                    <Route path="campaigns" element={<CampaignsPage />} />
                    <Route path="phone" element={<PhonePage />} />
                    <Route path="modules/:id" element={<ModulePage />} />
                    <Route path="setup" element={<SetupPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                </Route>
            </Routes>
        </ToastProvider>
    );
}
