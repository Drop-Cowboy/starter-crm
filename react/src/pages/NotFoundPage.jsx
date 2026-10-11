import { Link } from 'react-router';
import { Page } from '../components/Page.jsx';
import { usePageTitle } from '../hooks.js';
import { useAppPath } from '../layout-context.js';

export function NotFoundPage() {
    usePageTitle('Not found');
    const appPath = useAppPath();
    return (
        <Page title="Page not found">
            <p>There is no page at this address.</p>
            <p><Link to={appPath('/contacts')}>Go to contacts</Link></p>
        </Page>
    );
}
