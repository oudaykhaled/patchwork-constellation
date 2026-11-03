import { useEffect, useState } from 'react';

/** Only settled review data changes are announced; camera and hover never enter this region. */
export function ReviewAnnouncements({ busy, changedFiles, overlapFiles, selectedPath, sourceCount, coverage }: {
  busy: boolean; changedFiles: number; overlapFiles: number; selectedPath?: string;
  sourceCount: number; coverage: string;
}) {
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (busy) return;
    const timer = setTimeout(() => setMessage(`Review updated. ${sourceCount} selected sources, ${changedFiles} directly changed files, ${overlapFiles} overlapping files. Coverage: ${coverage}.${selectedPath ? ` Selected file: ${selectedPath}.` : ''}`), 180);
    return () => clearTimeout(timer);
  }, [busy, changedFiles, overlapFiles, selectedPath, sourceCount, coverage]);
  return <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="review-announcement">{message}</div>;
}
