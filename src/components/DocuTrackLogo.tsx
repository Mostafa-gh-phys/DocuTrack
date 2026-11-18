import React from 'react';

interface DocuTrackLogoProps {
  className?: string;
}

/**
 * Bold architectural wordmark derived directly from the name "DocuTrack"
 * rendered in Computer Modern Serif with a crisp typographic baseline mark.
 */
export const DocuTrackLogo: React.FC<DocuTrackLogoProps> = ({className = ''}) => {
  return (
    <span
      className={`inline-flex items-baseline gap-0 select-none font-docutrack-logo text-[22px] leading-none font-bold text-slate-950 dark:text-slate-50 ${className}`}
    >
      <span className="inline-flex items-center justify-center px-1.5 py-0.5 mr-0.5 rounded bg-slate-950 text-white dark:bg-blue-700 dark:text-white tracking-tight">
        D
      </span>
      <span>ocu</span>
      <span className="text-blue-800 dark:text-blue-400">Track</span>
    </span>
  );
};
