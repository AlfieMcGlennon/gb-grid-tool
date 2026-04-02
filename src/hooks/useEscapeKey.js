import { useEffect } from 'react'

export function useEscapeKey(modals) {
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        for (const modal of modals) {
          if (modal.isOpen) {
            modal.onClose();
            return;
          }
        }
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [modals]);
}
