import React, { useEffect, useId, useRef, useState } from 'react';
import { Question, X } from '@phosphor-icons/react';
import { resolveAdminHelp } from './help-content.js';
import './help-tip.css';

/** A nonmodal, scrollable explanation. Kept inside its parent dialog in the DOM
 * so native top-layer popovers remain usable while the form modal is open. */
export default function HelpTip({ topic, help, label }) {
  const entry = resolveAdminHelp(help || topic || label);
  const id = useId();
  const root = useRef(null), trigger = useRef(null), panel = useRef(null);
  const closeTimer = useRef(null), pinned = useRef(false), hovered = useRef(false);
  const restoringFocus = useRef(false);
  const transitioning = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 360, maxHeight: 440 });
  const clearTimer = () => { clearTimeout(closeTimer.current); closeTimer.current = null; };
  const place = () => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0, topEdge = viewport?.offsetTop || 0;
    const width = viewport?.width || window.innerWidth, height = viewport?.height || window.innerHeight;
    const gap = 10, margin = 12, panelWidth = Math.min(400, width - margin * 2);
    const below = topEdge + height - rect.bottom - gap - margin;
    const above = rect.top - topEdge - gap - margin;
    const upward = below < 220 && above > below;
    const maxHeight = Math.max(80, Math.min(480, height - margin * 2, upward ? above : below));
    setPosition({ width: panelWidth, maxHeight,
      left: Math.max(leftEdge + margin, Math.min(rect.left, leftEdge + width - margin - panelWidth)),
      top: upward ? Math.max(topEdge + margin, rect.top - gap - Math.min(panel.current?.scrollHeight || maxHeight, maxHeight))
        : Math.max(topEdge + margin, rect.bottom + gap),
    });
  };
  const close = () => {
    if (transitioning.current) return;
    transitioning.current = true;
    clearTimer(); pinned.current = false;
    try {
      if (panel.current?.hidePopover && panel.current.matches(':popover-open')) panel.current.hidePopover();
      setOpen(false);
    } finally { transitioning.current = false; }
  };
  const restoreFocus = () => {
    restoringFocus.current = true;
    trigger.current?.focus();
    restoringFocus.current = false;
  };
  const show = () => {
    if (!entry || transitioning.current || restoringFocus.current) return;
    transitioning.current = true;
    try {
      document.dispatchEvent(new CustomEvent('cp-admin-help-open', { detail: id }));
      clearTimer(); place();
      if (panel.current?.showPopover && !panel.current.matches(':popover-open')) panel.current.showPopover();
      setOpen(true);
    } finally { transitioning.current = false; }
  };
  const scheduleClose = () => {
    clearTimer();
    closeTimer.current = setTimeout(() => {
      if (!pinned.current && !hovered.current && !root.current?.contains(document.activeElement)) close();
    }, 200);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return;
    place();
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    const anotherHelp = event => { if (event.detail !== id) close(); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      const returnToTrigger = root.current?.contains(document.activeElement);
      close();
      if (returnToTrigger) restoreFocus();
    };
    const reposition = event => {
      // Scrolling the explanation itself must not move or dismiss it.
      if (panel.current?.contains(event.target)) return;
      place();
    };
    const nativeToggle = event => {
      if (event.newState === 'closed') { pinned.current = false; setOpen(false); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('cp-admin-help-open', anotherHelp);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const element = panel.current;
    element?.addEventListener('toggle', nativeToggle);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('cp-admin-help-open', anotherHelp);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      element?.removeEventListener('toggle', nativeToggle);
    };
  }, [open]);
  if (!entry) return null;
  const name = label || entry.title;
  return <span className="cp-admin-help" ref={root}
    onPointerEnter={event => { if (event.pointerType === 'mouse') { hovered.current = true; show(); } }}
    onPointerLeave={event => { if (event.pointerType === 'mouse') { hovered.current = false; scheduleClose(); } }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { pinned.current = false; scheduleClose(); } }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); restoreFocus(); } }}>
    <button type="button" ref={trigger} className="cp-admin-help-trigger"
      aria-label={`查看「${name}」的说明`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onFocus={show}
      onClick={event => { event.preventDefault(); event.stopPropagation();
        if (pinned.current) close(); else { show(); pinned.current = true; }
      }}><Question size={17} aria-hidden="true" /></button>
    <span ref={panel} id={id} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`}
      popover="auto" className={`cp-admin-help-panel${open ? ' is-open' : ''}`}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
      {open && <><span className="cp-admin-help-head"><strong id={`${id}-title`}>{entry.title}</strong>
        <button type="button" className="cp-admin-help-close" aria-label={`关闭「${name}」的说明`}
          onClick={event => { event.preventDefault(); event.stopPropagation(); close(); restoreFocus(); }}><X size={16} aria-hidden="true" /></button>
      </span>
      <span className="cp-admin-help-copy" tabIndex={0} aria-label={`${entry.title}详细说明`}>
        {entry.paragraphs?.map((paragraph, index) => <span className="cp-admin-help-paragraph" key={index}>{paragraph}</span>)}
        {entry.example && <span className="cp-admin-help-example"><b>例子</b>{entry.example}</span>}
        {entry.caution && <span className="cp-admin-help-caution"><b>注意</b>{entry.caution}</span>}
      </span></>}
    </span>
  </span>;
}

export { HelpTip };
