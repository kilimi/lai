import * as React from 'react';

export interface Insid3PickModeBannerProps {
  referenceCount: number;
  className?: string;
  pickableOnImage: number;
}

export function Insid3PickModeBanner({
  referenceCount,
  className,
  pickableOnImage,
}: Insid3PickModeBannerProps) {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none max-w-lg px-2">
      <div className="rounded-lg border border-amber-500/50 bg-amber-500/15 backdrop-blur-sm px-4 py-2 text-sm text-amber-50 shadow-lg">
        <p className="font-medium">INSID3 — click masks to add references</p>
        <p className="text-xs text-amber-100/90 mt-1">
          Click existing <span className="font-medium">{className || 'target class'}</span> polygons on
          the image{className ? '' : ' (choose target class in the sidebar)'}.
          {pickableOnImage > 0
            ? ` ${pickableOnImage} mask${pickableOnImage === 1 ? '' : 's'} on this image.`
            : ' No matching masks on this image — use Prev/Next to find examples.'}
          {' '}
          {referenceCount > 0
            ? `${referenceCount} reference${referenceCount === 1 ? '' : 's'} saved — click again to remove.`
            : 'Add at least one reference, then Preview or Find similar.'}
        </p>
      </div>
    </div>
  );
}
