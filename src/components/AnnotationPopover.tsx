import React, {useEffect, useState} from 'react';
import {Check, Copy, Tag, Trash2, X} from 'lucide-react';
import type {Annotation, HighlightColor} from '../types/library';

interface AnnotationPopoverProps {
  annotation: Annotation | null;
  copied: boolean;
  onUpdate: (id: string, patch: Partial<Pick<Annotation, 'note' | 'color' | 'tags'>>) => void;
  onDelete: (id: string) => void;
  onCopyCitation: (ann: Annotation) => void;
  onClose: () => void;
}

const SWATCHES: {id: HighlightColor; label: string; bg: string}[] = [
  {id: 'amber', label: 'Amber', bg: 'bg-amber-400'},
  {id: 'sage', label: 'Sage', bg: 'bg-emerald-400'},
  {id: 'sky', label: 'Sky', bg: 'bg-sky-400'},
  {id: 'rose', label: 'Rose', bg: 'bg-rose-400'},
  {id: 'violet', label: 'Violet', bg: 'bg-violet-400'},
];

export const AnnotationPopover: React.FC<AnnotationPopoverProps> = ({
  annotation,
  copied,
  onUpdate,
  onDelete,
  onCopyCitation,
  onClose,
}) => {
  const [noteDraft, setNoteDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    setNoteDraft(annotation?.note || '');
    setTagDraft('');
  }, [annotation?.id, annotation?.note]);

  if (!annotation) return null;

  const kindLabel = annotation.kind ? annotation.kind.toUpperCase() : 'HIGHLIGHT';

  return (
    <div
      role="dialog"
      aria-label="Edit inline annotation"
      data-testid="inline-annotation-popover"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed bottom-16 right-6 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-xl border app-border app-surface shadow-xl p-4 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide opacity-65 tabular-nums">
          {kindLabel} · Page {annotation.page}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onCopyCitation(annotation)}
            aria-label="Copy Zotero citation"
            title="Copy Zotero citation"
            className="p-1 rounded opacity-70 hover:opacity-100"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              onDelete(annotation.id);
              onClose();
            }}
            aria-label="Delete annotation"
            title="Delete annotation"
            className="p-1 rounded opacity-70 hover:opacity-100 hover:text-red-500"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close annotation popover"
            className="p-1 rounded opacity-60 hover:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <p className="text-xs italic opacity-80 line-clamp-2 border-l-2 pl-2 app-border">
        "{annotation.quote}"
      </p>

      {/* Color Picker */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] opacity-65">Color</span>
        <div className="flex items-center gap-1.5">
          {SWATCHES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-label={`Set color ${s.label}`}
              aria-pressed={annotation.color === s.id}
              onClick={() => onUpdate(annotation.id, {color: s.id})}
              className={`w-4 h-4 rounded-full ${s.bg} transition-transform ${
                annotation.color === s.id ? 'ring-2 ring-offset-1 ring-current scale-110' : 'opacity-70 hover:opacity-100'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Inline Note Editor */}
      <div className="space-y-1.5">
        <label htmlFor="inline-ann-note" className="block text-[11px] opacity-65">
          Margin Note
        </label>
        <textarea
          id="inline-ann-note"
          rows={2}
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Add note..."
          className="w-full text-xs p-2 rounded-lg border app-border bg-transparent focus:outline-none"
        />
        {noteDraft !== annotation.note && (
          <button
            type="button"
            onClick={() => onUpdate(annotation.id, {note: noteDraft})}
            className="px-2.5 py-1 rounded-md accent-btn text-[11px] font-medium"
          >
            Save Note
          </button>
        )}
      </div>

      {/* Tags Row */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {(annotation.tags || []).map((t) => (
            <span key={t} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border app-border text-[11px]">
              #{t}
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                onClick={() =>
                  onUpdate(annotation.id, {
                    tags: (annotation.tags || []).filter((x) => x !== t),
                  })
                }
                className="hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const cleaned = tagDraft.replace(/^#/, '').trim();
            if (!cleaned) return;
            const nextTags = Array.from(new Set([...(annotation.tags || []), cleaned])).slice(0, 10);
            onUpdate(annotation.id, {tags: nextTags});
            setTagDraft('');
          }}
          className="flex items-center gap-1.5"
        >
          <Tag className="w-3 h-3 opacity-50 shrink-0" aria-hidden="true" />
          <input
            type="text"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder="Add tag & press Enter..."
            className="flex-1 px-2 py-1 rounded border app-border bg-transparent text-[11px]"
          />
        </form>
      </div>
    </div>
  );
};
