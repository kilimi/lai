/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditProjectDialog } from "@/components/EditProjectDialog";
import type { Project } from "@/types";

const mockUpdateProject = vi.fn();

vi.mock("@/utils/api", () => ({
  createApiClient: () => ({
    updateProject: mockUpdateProject,
  }),
}));

vi.mock("@/config/api", () => ({
  API_CONFIG: { baseUrl: "http://localhost:9999" },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const project: Project = {
  id: 5,
  name: "Original",
  description: "Old desc",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  is_project: true,
  datasets: [],
  tags: ["a"],
};

describe("EditProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateProject.mockResolvedValue({
      success: true,
      data: { ...project, name: "Updated" },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("saves valid updates", async () => {
    const user = userEvent.setup();
    const onProjectUpdated = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <EditProjectDialog
        project={project}
        open
        onOpenChange={onOpenChange}
        onProjectUpdated={onProjectUpdated}
      />,
    );

    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "Updated Name");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockUpdateProject).toHaveBeenCalledWith("5", expect.any(FormData)));
    expect(onProjectUpdated).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows error when name is empty", async () => {
    const user = userEvent.setup();
    render(
      <EditProjectDialog
        project={project}
        open
        onOpenChange={vi.fn()}
        onProjectUpdated={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("Project Name"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  it("rejects name shorter than 2 characters", async () => {
    const user = userEvent.setup();
    render(
      <EditProjectDialog
        project={project}
        open
        onOpenChange={vi.fn()}
        onProjectUpdated={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockUpdateProject).not.toHaveBeenCalled();
  });
});
