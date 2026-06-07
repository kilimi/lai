/* @vitest-environment jsdom */

import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, it, expect } from "vitest";
import { ProjectCard } from "./ProjectCard";
import type { Project } from "@/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: "Demo Project",
    description: "Demo description",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_project: true,
    datasets: [],
    tags: [],
    ...overrides,
  };
}

describe("ProjectCard logo rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders project logo from logo_url when present", () => {
    const project = makeProject({
      logo_url: "data:image/jpeg;base64,AAA",
    });

    const { container } = render(
      <MemoryRouter>
        <ProjectCard project={project} />
      </MemoryRouter>,
    );

    const img = container.querySelector('img[alt="Demo Project"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,AAA");
  });

  it("falls back to thumbnailUrl when logo_url is missing", () => {
    const project = makeProject({
      logo_url: undefined,
      thumbnailUrl: "data:image/jpeg;base64,BBB",
    });

    const { container } = render(
      <MemoryRouter>
        <ProjectCard project={project} />
      </MemoryRouter>,
    );

    const img = container.querySelector('img[alt="Demo Project"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("data:image/jpeg;base64,BBB");
  });

  it("shows placeholder state when both logo_url and thumbnailUrl are missing", () => {
    const project = makeProject({
      logo_url: undefined,
      thumbnailUrl: undefined,
    });

    const { container } = render(
      <MemoryRouter>
        <ProjectCard project={project} />
      </MemoryRouter>,
    );

    const img = container.querySelector('img[alt="Demo Project"]');
    expect(img).toBeNull();
    expect(screen.getByText("Demo Project")).toBeTruthy();
  });
});
