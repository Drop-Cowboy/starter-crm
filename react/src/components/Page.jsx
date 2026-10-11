import { Icon } from './Icon.jsx';

/** The heading and one-line explanation at the top of a full-width page. */
export function Page({ title, hint, children }) {
    return (
        <div className="page">
            <header className="page-h">
                <h1>{title}</h1>
                {hint && <p className="hint">{hint}</p>}
            </header>
            {children}
        </div>
    );
}

/** Marks what on the page is a Drop Cowboy widget, and which one it is. */
export function WidgetTag({ name }) {
    return (
        <div className="wa-tag">
            <span className="dcm" aria-hidden="true">DC</span>Drop Cowboy widget · <code>{name}</code>
        </div>
    );
}

/**
 * The frame around a Drop Cowboy widget: its tag, then the widget (or its
 * loading and error states). `grow` lets it fill the rest of the page.
 */
export function Widget({ name, grow, children }) {
    return (
        <div className={grow ? 'wa grow' : 'wa'}>
            <WidgetTag name={name} />
            {children}
        </div>
    );
}

export function DncBadge() {
    return <span className="badge danger"><Icon name="ban" />Do not call</span>;
}
