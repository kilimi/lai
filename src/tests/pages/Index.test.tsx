/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import Index from "@/pages/Index";
import type { Project } from "@/types";

const mockRefetch = vi.fn();
let mockProjects: Project[] = [];
let mockLoading = false;
let mockError: string | null = null;

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => ({
    projects: mockProjects,
    loading: mockLoading,
    error: mockError,
    refetch: mockRefetch,
  }),
}));

vi.mock("@/hooks/useStableLoading", () => ({
  useStableLoading: (loading: boolean) => loading,
}));

vi.mock("@/components/Navbar", () => ({
  Navbar: () => <nav data-testid="navbar" />,
}));

vi.mock("@/components/ProjectCard", () => ({
  ProjectCard: ({ project }: { project: Project }) => (
    <div data-testid="project-card">{project.name}</div>
  ),
  ProjectCardSkeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const baseProject = (id: number, name: string, extra: Partial<Project> = {}): Project => ({
  id,
  name,
  description: extra.description ?? "",
  created_at: extra.created_at ?? "2026-03-01T00:00:00.000Z",
  updated_at: extra.updated_at ?? "2026-03-01T00:00:00.000Z",
  is_project: true,
  datasets: extra.datasets ?? [],
  tags: extra.tags,
});

describe("Index (Projects page)", () => {
  beforeEach(() => {
    mockProjects = [];
    mockLoading = false;
    mockError = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const renderPage = () =>
    render(
      <MemoryRouter>
        <Index />
      </MemoryRouter>,
    );

  it("shows loading skeletons", () => {
    mockLoading = true;
    renderPage();
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("shows connection error state", () => {
    mockError = "Network down";
    renderPage();
    const main = screen.getByRole("main");
    expect(within(main).getByText("Connection Error")).toBeTruthy();
    expect(within(main).getByText("Network down")).toBeTruthy();
    expect(within(main).getByRole("link", { name: /settings/i })).toBeTruthy();
  });

  it("shows empty onboarding when no projects", () => {
    renderPage();
    const main = screen.getByRole("main");
    expect(within(main).getByText("Welcome to LAI Studio")).toBeTruthy();
    expect(within(main).getAllByRole("link", { name: /create your first project/i }).length).toBeGreaterThan(0);
  });

  it("filters projects by search", async () => {
    const user = userEvent.setup();
    mockProjects = [
      baseProject(1, "Alpha"),
      baseProject(2, "Beta"),
    ];
    renderPage();
    const main = screen.getByRole("main");

    await user.type(within(main).getByPlaceholderText("Search projects..."), "beta");

    expect(within(main).getByTestId("project-card")).toHaveTextContent("Beta");
    expect(within(main).queryAllByTestId("project-card")).toHaveLength(1);
  });

  it("shows filtered empty state and clears filters", async () => {
    const user = userEvent.setup();
    mockProjects = [baseProject(1, "Only One")];
    renderPage();

    await user.type(screen.getByPlaceholderText("Search projects..."), "zzz");
    expect(screen.getByText("No matching projects")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear Filters" }));
    expect(screen.getByTestId("project-card")).toHaveTextContent("Only One");
  });

  it("displays stats in header", () => {
    mockProjects = [
      baseProject(1, "A", {
        datasets: [
          {
            id: 10,
            name: "d",
            description: "",
            tags: [],
            created_at: "",
            updated_at: "",
            image_count: 3,
            annotation_count: 0,
            annotation_file_count: 0,
            project_id: 1,
          },
        ],
      }),
    ];
    renderPage();
    const main = screen.getByRole("main");
    expect(within(main).getByText("1 project · 1 dataset · 3 images")).toBeTruthy();
  });

  it("calls refetch on refresh click", async () => {
    const user = userEvent.setup();
    mockProjects = [baseProject(1, "A")];
    renderPage();

    await user.click(screen.getByRole("button", { name: "Refresh projects" }));
    expect(mockRefetch).toHaveBeenCalled();
  });
});
