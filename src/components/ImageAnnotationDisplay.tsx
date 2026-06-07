
import React from 'react';
import { AnnotationSample } from '@/utils/annotations';

interface ImageAnnotationDisplayProps {
  annotations: (AnnotationSample & { annotationFileName?: string })[];
}

// Helper: get display name for annotation
function getAnnotationDisplayName(annotation: AnnotationSample): string {
  // Try different properties that could serve as a name
  if (annotation.id && annotation.id !== annotation.className) return annotation.id;
  if (annotation.annotationFileName) return annotation.annotationFileName;
  
  // If no unique identifier, just return the class name
  return annotation.className;
}

// Helper: group annotations by class and annotation file with counts
function groupAnnotationsByClassAndFile(annotations: (AnnotationSample & { annotationFileName?: string })[]): Array<{
  className: string;
  annotationFileName: string;
  color: string;
  count: number;
}> {
  const groupMap = new Map<string, {
    className: string;
    annotationFileName: string;
    color: string;
    count: number;
  }>();

  annotations.forEach(annotation => {
    const fileName = annotation.annotationFileName || 'Unknown';
    const key = `${annotation.className}_${fileName}`;
    
    if (groupMap.has(key)) {
      groupMap.get(key)!.count++;
    } else {
      groupMap.set(key, {
        className: annotation.className,
        annotationFileName: fileName,
        color: annotation.color || '#ea384c',
        count: 1
      });
    }
  });

  return Array.from(groupMap.values()).sort((a, b) => {
    // Sort by class name first, then by annotation file name
    if (a.className !== b.className) {
      return a.className.localeCompare(b.className);
    }
    return a.annotationFileName.localeCompare(b.annotationFileName);
  });
}

export const ImageAnnotationDisplay = ({ annotations }: ImageAnnotationDisplayProps) => {
  if (!annotations || annotations.length === 0) {
    return <div className="text-sm text-gray-400">No annotations to display</div>;
  }

  const groupedAnnotations = groupAnnotationsByClassAndFile(annotations);

  return (
    <div className="text-sm text-gray-400">
      <div className="text-left">
        {groupedAnnotations.map((group, index) => (
          <span key={`${group.className}-${group.annotationFileName}-${index}`} className="flex items-center gap-1">
            <span style={{ display: 'inline-block', width: 10, height: 10, background: group.color, borderRadius: '50%' }} />
            {group.className} ({group.annotationFileName}) ({group.count})
            {index < groupedAnnotations.length - 1 ? ', ' : ''}
          </span>
        ))}
      </div>
    </div>
  );
};
