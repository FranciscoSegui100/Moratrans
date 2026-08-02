import { useEffect, useState, createContext, useContext, ReactNode } from 'react';

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  title: string;
  desc?: string;
}

interface ToastCtx {
  show: (type: Toast['type'], title: string, desc?: string) => void;
}

const ToastContext = createContext<ToastCtx>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const icons = { success: '✅', error: '❌', info: 'ℹ️' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  let counter = 0;

  function show(type: Toast['type'], title: string, desc?: string) {
    const id = ++counter + Date.now();
    setToasts((prev) => [...prev, { id, type, title, desc }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span className="toast-icon">{icons[t.type]}</span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.desc && <div className="toast-desc">{t.desc}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
