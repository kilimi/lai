/* @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import CreateProject from "@/pages/CreateProject";

const mockNavigate = vi.fn();
const mockCreateProject = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/utils/api", () => ({
  createApiClient: () => ({
    createProject: mockCreateProject,
  }),
}));

vi.mock("@/config/api", () => ({
  API_CONFIG: { baseUrl: "http://localhost:9999" },
}));

vi.mock("@/components/Navbar", () => ({
  Navbar: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("CreateProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateProject.mockResolvedValue({ success: true, data: { id: 1, name: "New" } });
  });

  afterEach(() => {
    cleanup();
  });

  it("disables submit when name is empty", () => {
    render(
      <MemoryRouter>
        <CreateProject />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("submits project and navigates home with refetch", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateProject />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Name"), "My Project");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith("/", { state: { refetch: true } });
  });

  it("rejects invalid logo file type", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateProject />
      </MemoryRouter>,
    );

    const input = document.querySelector('input#project-logo') as HTMLInputElement;
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    await user.upload(input, file);

    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("navigates home on cancel", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateProject />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });
});
