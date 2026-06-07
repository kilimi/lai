import '@testing-library/jest-dom';
import { beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API_CONFIG } from '../config/api';

const baseUrl = API_CONFIG?.baseUrl || 'http://localhost:9999';

export const handlers = [
  http.post(`${baseUrl}/projects`, () => {
    return HttpResponse.json({
      success: true,
      data: {
        id: 1,
        name: 'Test Project',
        description: 'Test Description',
        tags: ['test'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        datasets: [],
        logo_url: null,
        is_project: true
      }
    }, { status: 201 });
  }),

  http.get(`${baseUrl}/projects`, () => {
    return HttpResponse.json({
      success: true,
      data: [
        {
          id: 1,
          name: 'Test Project',
          description: 'Test Description',
          tags: ['test'],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          datasets: [],
          logo_url: null,
          is_project: true
        }
      ]
    });
  }),

  http.put(`${baseUrl}/projects/:id`, () => {
    return HttpResponse.json({
      success: true,
      data: {
        id: 1,
        name: 'Updated Project',
        description: 'Updated Description',
        tags: ['updated'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        datasets: [],
        logo_url: null,
        is_project: true
      }
    });
  }),

  http.delete(`${baseUrl}/projects/:id`, () => {
    return HttpResponse.json({
      success: true
    });
  })
];

const server = setupServer(...handlers);

beforeAll(() => {
  /** jsdom does not implement ResizeObserver; components that observe layout need a stub. */
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as typeof ResizeObserver;
  /**
   * Radix Select relies on Pointer Capture APIs that jsdom doesn't implement.
   * Stub them so pointer interactions in tests don't throw unhandled errors.
   */
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  // Radix Select also calls scrollIntoView in effects; jsdom can miss it on candidates.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  server.listen();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());