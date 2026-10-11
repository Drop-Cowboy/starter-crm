import { useNavigate } from 'react-router';
import { DcPipelineBoard } from '../blocks/DcPipelineBoard.jsx';
import { ErrorNotice, Loading } from '../components/Notice.jsx';
import { Page, Widget } from '../components/Page.jsx';
import { useContactWidgets, usePageTitle } from '../hooks.js';
import { useAppPath } from '../layout-context.js';

/** The pipeline board. Opening a card opens that contact here. */
export function PipelinePage() {
    usePageTitle('Pipeline');
    const navigate = useNavigate();
    const appPath = useAppPath();
    const { tokenManager, error } = useContactWidgets(['dc-pipeline-board']);
    let body = <Loading label="Loading pipeline…" />;
    if (error) {
        body = <ErrorNotice error={error} />;
    } else if (tokenManager) {
        body = <DcPipelineBoard tokenManager={tokenManager} onOpenContact={(id) => navigate(appPath('/contacts/' + encodeURIComponent(id)))} />;
    }
    return (
        <Page title="Pipeline" hint="Drag a card to another stage, or use its Move to stage menu. Stages live in Drop Cowboy.">
            <Widget name="<dc-pipeline-board>" grow>{body}</Widget>
        </Page>
    );
}
