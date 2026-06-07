import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { resolveClassFilterToggleNavigation } from '@/pages/ImageAnnotation';

function FilterHarness() {
  const baseImages = ['img_1.jpg', 'img_2.jpg', 'img_3.jpg'];
  const classImageMap = {
    cat: new Set(['img_2.jpg', 'img_3.jpg']),
  };

  const [classFilterName, setClassFilterName] = useState<string | null>(null);
  const [currentImageName, setCurrentImageName] = useState<string>(baseImages[0]);

  const onToggle = () => {
    const nav = resolveClassFilterToggleNavigation(
      baseImages,
      classImageMap,
      classFilterName,
      'cat'
    );
    setClassFilterName(nav.nextFilterName);
    if (nav.firstImage) setCurrentImageName(nav.firstImage);
  };

  return (
    <div>
      <button aria-label="class-filter-icon" onClick={onToggle}>
        filter
      </button>

      {classFilterName && (
        <div>
          Navigating images with <strong>{classFilterName}</strong>
          <button onClick={() => {
            const nav = resolveClassFilterToggleNavigation(baseImages, classImageMap, classFilterName, classFilterName);
            setClassFilterName(nav.nextFilterName);
            if (nav.firstImage) setCurrentImageName(nav.firstImage);
          }}>
            Clear
          </button>
        </div>
      )}

      <div data-testid="current-image">{currentImageName}</div>
      <div data-testid="filter-state">{classFilterName ?? 'none'}</div>
    </div>
  );
}

describe('ImageAnnotation class filter icon UI flow', () => {
  it('toggles filter with icon click and updates indicator + image navigation', () => {
    render(<FilterHarness />);

    expect(screen.getByTestId('current-image')).toHaveTextContent('img_1.jpg');
    expect(screen.getByTestId('filter-state')).toHaveTextContent('none');
    expect(screen.queryByText(/Navigating images with/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('class-filter-icon'));

    expect(screen.getByText(/Navigating images with/i)).toBeInTheDocument();
    expect(screen.getByTestId('filter-state')).toHaveTextContent('cat');
    expect(screen.getByTestId('current-image')).toHaveTextContent('img_2.jpg');

    fireEvent.click(screen.getByLabelText('class-filter-icon'));

    expect(screen.queryByText(/Navigating images with/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-state')).toHaveTextContent('none');
    expect(screen.getByTestId('current-image')).toHaveTextContent('img_1.jpg');
  });

  it('clear action removes indicator and resets to first image', () => {
    render(<FilterHarness />);

    fireEvent.click(screen.getByLabelText('class-filter-icon'));
    expect(screen.getByTestId('current-image')).toHaveTextContent('img_2.jpg');

    fireEvent.click(screen.getByText('Clear'));

    expect(screen.queryByText(/Navigating images with/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-state')).toHaveTextContent('none');
    expect(screen.getByTestId('current-image')).toHaveTextContent('img_1.jpg');
  });
});
