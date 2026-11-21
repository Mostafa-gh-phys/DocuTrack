import React from 'react';

interface DocuTrackLogoProps {
  className?: string;
}

/**
 * Editorial wordmark derived directly from "DocuTrack":
 * whole "Docu" set inside a crisp black cadre paired with "Track" in Computer Modern Serif.
 */
export const DocuTrackLogo: React.FC<DocuTrackLogoProps> = ({className = ''}) => {
  return (
    <span
      className={`inline-flex items-baseline gap-1 select-none font-docutrack-logo text-[22px] leading-none font-bold text-slate-950 dark:text-slate-50 ${className}`}
    >
      <span
        data-testid="docu-cadre"
        className="inline-flex items-center justify-center px-2 py-[3px] rounded-[3px] bg-black text-white border border-black dark:bg-black dark:text-white dark:border-white/75 tracking-tight shadow-2xs"
      >
        Docu
      </span>
      <span className="tracking-tight text-slate-900 dark:text-slate-100">Track</span>
    </span>
  );
};
