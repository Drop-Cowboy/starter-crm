import { iconHref } from '@shared/ui.js';

/** A decorative icon from shared/icons.svg. The control around it carries the name. */
export function Icon({ name }) {
    return (
        <svg className="ic" aria-hidden="true" focusable="false">
            <use href={iconHref(name)} />
        </svg>
    );
}
