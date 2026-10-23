import {useEffect, useState} from 'react';

/** Redraw as reports age, but sample now on every render, including query updates. */
export function useClock() {
  const [, setTick] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  return Date.now();
}
