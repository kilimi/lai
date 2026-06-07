import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApiUrl,
  getApiBaseUrl,
  normalizeApiBaseForBrowser,
  resolveBackendMediaUrl,
} from "./api";

function mockLocation(origin: string, hostname: string) {
  vi.stubGlobal("window", {
    location: { origin, hostname, protocol: origin.startsWith("https") ? "https:" : "http:" },
  });
}

describe("normalizeApiBaseForBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rewrites loopback API host to LAN page host", () => {
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(normalizeApiBaseForBrowser("http://localhost:9999")).toBe(
      "http://192.168.1.10:9999",
    );
  });

  it("aligns localhost API with 127.0.0.1 page host", () => {
    mockLocation("http://127.0.0.1:8080", "127.0.0.1");
    expect(normalizeApiBaseForBrowser("http://localhost:9999")).toBe(
      "http://127.0.0.1:9999",
    );
  });
});

describe("getApiBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("uses same origin in dev", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    mockLocation("http://192.168.1.10:8080", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("http://192.168.1.10:8080");
  });

  it("uses same origin when VITE_API_URL is SAME_ORIGIN", () => {
    vi.stubEnv("VITE_API_URL", "SAME_ORIGIN");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("http://192.168.1.10:8089");
  });

  it("uses same origin when VITE_API_URL is loopback on another port (docker default)", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("http://192.168.1.10:8089");
  });

  it("uses same origin for loopback API when UI is on localhost:8089", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    mockLocation("http://localhost:8089", "localhost");
    expect(getApiBaseUrl()).toBe("http://localhost:8089");
  });

  it("uses same origin when apiBaseUrl in localStorage is loopback:9999", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    localStorage.setItem("apiBaseUrl", "http://localhost:9999");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("http://192.168.1.10:8089");
  });

  it("keeps explicit remote API URL from Settings", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    localStorage.setItem("apiBaseUrl", "https://api.example.com");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("https://api.example.com");
  });

  it("ignores loopback apiBaseUrl in Settings and uses page origin", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "SAME_ORIGIN");
    localStorage.setItem("apiBaseUrl", "http://localhost:9999");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    expect(getApiBaseUrl()).toBe("http://192.168.1.10:8089");
  });
});

describe("resolveBackendMediaUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("rewrites /static paths on docker internal host to page origin", () => {
    vi.stubEnv("VITE_API_URL", "SAME_ORIGIN");
    mockLocation("http://localhost:8089", "localhost");
    expect(
      resolveBackendMediaUrl(
        "http://backend:8000/static/projects/44/64/images/a.jpg?thumb=300",
      ),
    ).toBe("http://localhost:8089/static/projects/44/64/images/a.jpg?thumb=300");
  });

  it("fixes API URLs missing port (nginx Host without port)", () => {
    vi.stubEnv("VITE_API_URL", "SAME_ORIGIN");
    mockLocation("http://localhost:8089", "localhost");
    expect(
      resolveBackendMediaUrl(
        "http://localhost/static/projects/45/65/images/a.jpg",
      ),
    ).toBe("http://localhost:8089/static/projects/45/65/images/a.jpg");
  });

  it("rewrites relative /static paths", () => {
    vi.stubEnv("VITE_API_URL", "SAME_ORIGIN");
    mockLocation("http://localhost:8089", "localhost");
    expect(resolveBackendMediaUrl("/static/projects/44/64/images/a.jpg")).toBe(
      "http://localhost:8089/static/projects/44/64/images/a.jpg",
    );
  });
});

describe("buildApiUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds training test-inference URL with query", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    mockLocation("http://localhost:8080", "localhost");
    const url = buildApiUrl("/training/108/test-inference", { checkpoint: "best" });
    expect(url).toBe(
      "http://localhost:8080/training/108/test-inference?checkpoint=best",
    );
  });

  it("proxies test-inference through page origin when API is loopback:9999 on LAN", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_API_URL", "http://localhost:9999");
    mockLocation("http://192.168.1.10:8089", "192.168.1.10");
    const url = buildApiUrl("/training/108/test-inference", { checkpoint: "best" });
    expect(url).toBe(
      "http://192.168.1.10:8089/training/108/test-inference?checkpoint=best",
    );
  });
});
