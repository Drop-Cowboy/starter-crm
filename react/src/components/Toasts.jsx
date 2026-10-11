import { createContext, useCallback, useContext, useState } from 'react';

const TOAST_MS = 5000;
const ToastContext = createContext(() => {});

/** Short messages in one polite live region, so screen readers hear them too. */
export function ToastProvider({ children }) {
    const [toasts, setToasts] = useState([]);

    const toast = useCallback((text) => {
        const id = crypto.randomUUID();
        setToasts((list) => list.concat({ id, text }));
        setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), TOAST_MS);
    }, []);

    return (
        <ToastContext value={toast}>
            {children}
            <div className="toasts" id="toasts" role="status" aria-live="polite">
                {toasts.map((t) => <div className="toast" key={t.id}>{t.text}</div>)}
            </div>
        </ToastContext>
    );
}

/** @returns {(text: string) => void} */
export function useToast() {
    return useContext(ToastContext);
}
