import { useState, useEffect } from 'react'

export function useDebouncedLocal(parentValue, onChange, delay = 300) {
  const [localValue, setLocalValue] = useState(parentValue);

  useEffect(() => {
    setLocalValue(parentValue);
  }, [parentValue]);

  useEffect(() => {
    if (localValue === parentValue) return;
    const timer = setTimeout(() => { onChange(localValue); }, delay);
    return () => clearTimeout(timer);
  }, [localValue]);

  return [localValue, setLocalValue];
}
