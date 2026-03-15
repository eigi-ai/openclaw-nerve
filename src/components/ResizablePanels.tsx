import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

/** Props for {@link ResizablePanels}. */
interface ResizablePanelsProps {
  /** Content rendered in the left pane. */
  left: ReactNode;
  /** Content rendered in the right pane. */
  right: ReactNode;
  /** Current width of the left pane as a percentage (0–100). */
  leftPercent: number;
  /** Callback fired on drag-end with the new left-pane percentage. */
  onResize: (leftPercent: number) => void;
  /** Minimum left-pane width percentage. @default 30 */
  minLeftPercent?: number;
  /** Maximum left-pane width percentage. @default 75 */
  maxLeftPercent?: number;
  /** Additional class names for the left pane wrapper. */
  leftClassName?: string;
  /** Additional class names for the right pane wrapper. */
  rightClassName?: string;
  /** Optional explicit right panel pixel width (reserved for layout integrations). */
  rightWidthPx?: number | null;
  /** Optional callback for explicit right panel width updates (reserved). */
  onRightWidthChange?: (width: number | null) => void;
}

/**
 * Horizontally resizable two-pane layout with a draggable divider.
 *
 * Supports drag resizing, clamped min/max constraints, and double-click
 * to reset to the 55 % default split. Used as the main layout container
 * in the Nerve cockpit (sessions list + chat area).
 */
export function ResizablePanels({
  left,
  right,
  leftPercent,
  onResize,
  minLeftPercent = 30,
  maxLeftPercent = 75,
  leftClassName = '',
  rightClassName = '',
}: ResizablePanelsProps) {
  const [localPercent, setLocalPercent] = useState(leftPercent);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  // Sync local state when prop changes (e.g., from localStorage load)
  useEffect(() => {
    if (!isDragging.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from controlled prop
      setLocalPercent(leftPercent);
    }
  }, [leftPercent]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newPercent = ((e.clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(minLeftPercent, Math.min(maxLeftPercent, newPercent));
    setLocalPercent(clamped);
  }, [minLeftPercent, maxLeftPercent]);

  const handleMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResize(localPercent);
    }
  }, [localPercent, onResize]);

  // Double-click to reset to default (55%)
  const handleDoubleClick = useCallback(() => {
    const defaultPercent = 55;
    setLocalPercent(defaultPercent);
    onResize(defaultPercent);
  }, [onResize]);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return (
    <div ref={containerRef} className="flex-1 flex overflow-hidden">
      {/* Left panel */}
      <div
        className={`min-h-0 overflow-hidden ${leftClassName}`}
        style={{ flex: `${localPercent} 1 0%`, minWidth: 0 }}
      >
        {left}
      </div>
      
      {/* Resize handle */}
      <div
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className="w-1 bg-border hover:bg-primary/50 active:bg-primary/70 transition-colors cursor-col-resize shrink-0 group relative"
        title="Drag to resize • Double-click to reset"
      >
        {/* Visual feedback line on hover */}
        <div className="absolute inset-y-0 -left-0.5 -right-0.5 opacity-0 group-hover:opacity-100 bg-primary/20 transition-opacity pointer-events-none" />
      </div>
      
      {/* Right panel */}
      <div
        className={`min-h-0 overflow-hidden ${rightClassName}`}
        style={{ flex: `${100 - localPercent} 1 0%`, minWidth: 0 }}
      >
        {right}
      </div>
    </div>
  );
}
