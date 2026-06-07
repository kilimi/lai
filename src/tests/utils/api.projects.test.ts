import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient } from "@/utils/api";

describe("ApiClient project endpoints", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new ApiClient({ baseUrl: "http://api.test" });

  it("getProjects requests list with include_images", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify([{ id: 1, name: "P" }]),
    });

    const res = await client.getProjects();
    expect(res.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/projects/?include_images=true");
  });

  it("createProject sends multipart FormData", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({
          success: true,
          data: { id: 2, name: "N", datasets: [] },
        }),
    });

    const fd = new FormData();
    fd.append("name", "N");
    fd.append("description", "D");
    fd.append("tags", JSON.stringify(["t"]));

    await client.createProject(fd);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("updateProject uses PUT with FormData", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ success: true, data: { id: 3, name: "U" } }),
    });

    const fd = new FormData();
    fd.append("name", "U");
    await client.updateProject(3, fd);

    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/projects/3");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT");
  });

  it("deleteProject uses DELETE", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ success: true, message: "deleted" }),
    });

    await client.deleteProject(4);
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/projects/4");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });

  it("duplicateProject uses POST", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => "application/json" },
      text: async () =>
        JSON.stringify({ success: true, data: { id: 5, name: "Copy" } }),
    });

    await client.duplicateProject(5);
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/projects/5/duplicate");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
});
