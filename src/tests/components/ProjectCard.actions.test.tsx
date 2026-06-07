/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ProjectCard } from "@/components/ProjectCard";
import type { Project } from "@/types";

const mockNavigate = vi.fn();
const mockDeleteProject = vi.fn();
const mockDuplicateProject = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/utils/api", () => ({
  createApiClient: () => ({
    deleteProject: mockDeleteProject,
    duplicateProject: mockDuplicateProject,
  }),
}));

vi.mock("@/config/api", () => ({
  API_CONFIG: { baseUrl: "http://localhost:9999" },
  resolveBackendMediaUrl: (url: string) => url || "",
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/useAnnotationFilesCount", () => ({
  useAnnotationFilesCount: () => 0,
}));

vi.mock("@/components/EditProjectDialog", () => ({
  EditProjectDialog: () => null,
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 42,
    name: "Card Project",
    description: "Desc",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_project: true,
    datasets: [],
    tags: ["tag-a"],
    ...overrides,
  };
}

describe("ProjectCard actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteProject.mockResolvedValue({ success: true });
    mockDuplicateProject.mockResolvedValue({
      success: true,
      data: makeProject({ id: 99, name: "Card Project (Copy)" }),
    });
  });

  afterEach(() => {
    cleanup();
  });

  const renderCard = (props: Partial<Parameters<typeof ProjectCard>[0]> = {}) =>
    render(
      <MemoryRouter>
        <ProjectCard project={makeProject()} {...props} />
      </MemoryRouter>,
    );

  it("navigates to project datasets on card click", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByText("Card Project"));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/42/datasets");
  });

  it("deletes project and calls onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderCard({ onDelete });

    await user.click(screen.getByTestId("project-card-menu"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() => expect(mockDeleteProject).toHaveBeenCalledWith(42));
    expect(onDelete).toHaveBeenCalled();
  });

  it("duplicates project and calls onUpdate", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    renderCard({ onUpdate });

    await user.click(screen.getByTestId("project-card-menu"));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(mockDuplicateProject).toHaveBeenCalledWith(42));
    expect(onUpdate).toHaveBeenCalled();
  });

  it("shows dataset mosaic when datasets have thumbnails", () => {
    renderCard({
      project: makeProject({
        datasets: [
          {
            id: 1,
            name: "D1",
            description: "",
            tags: [],
            created_at: "",
            updated_at: "",
            image_count: 1,
            annotation_count: 0,
            annotation_file_count: 0,
            project_id: 42,
            thumbnailUrl: "/static/x.jpg",
          },
        ],
      }),
    });
    const imgs = document.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThan(0);
  });
});
