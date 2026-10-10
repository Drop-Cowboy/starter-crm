import { connectContactWidget, contactWidgets } from '/shared/widgets.js';
import { show } from '../dom.js';
import { errorNotice, loading } from '../notice.js';
import { page, widgetFrame } from '../page.js';

/**
 * The pipeline board loads the team's first board (or board-id) by itself,
 * with the contacts token manager. Opening a card opens that contact here.
 */
export async function renderPipeline(main, { crm, navigate, isCurrent }) {
    const status = loading('Loading pipeline…');
    show(main, page('Pipeline',
        'Drag a card to another stage, or use its Move to stage menu. Stages live in Drop Cowboy.',
        widgetFrame('dc-pipeline-board', { grow: true }, status)
    ));

    let tokenManager;
    try {
        ({ tokenManager } = await contactWidgets(crm, ['dc-pipeline-board']));
    } catch (err) {
        status.replaceWith(errorNotice(err, crm));
        return undefined;
    }
    if (!isCurrent()) {
        return undefined;
    }

    const board = document.createElement('dc-pipeline-board');
    board.className = 'widget';
    connectContactWidget(board, crm, tokenManager);
    board.addEventListener('dc-open-contact', (event) => {
        const detail = event.detail || {};
        // This event names the id contactId; most others say contact_id.
        const id = detail.contact_id || detail.contactId;
        if (id) {
            navigate('/contacts/' + encodeURIComponent(id));
        }
    });
    status.replaceWith(board);
    return undefined;
}
