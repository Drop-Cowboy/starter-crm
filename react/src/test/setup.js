// jsdom has <dialog> but not showModal() or close(). This is just enough of
// them for the app's dialogs: the open attribute and the close event.
if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
        if (this.hasAttribute('open')) {
            this.removeAttribute('open');
            this.dispatchEvent(new Event('close'));
        }
    };
}

// jsdom has no EventSource. The shell opens one for live events; in tests it
// never connects.
if (!globalThis.EventSource) {
    globalThis.EventSource = class extends EventTarget {
        static CLOSED = 2;
        readyState = 0;
        close() {
            this.readyState = 2;
        }
    };
}
