import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "../../components/StatusBadge";

describe("StatusBadge", () => {
  it("renders running status correctly", () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("renders completed status correctly", () => {
    render(<StatusBadge status="completed" />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("renders failed status correctly", () => {
    render(<StatusBadge status="failed" />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("renders pending status correctly", () => {
    render(<StatusBadge status="pending" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("renders stopped status correctly", () => {
    render(<StatusBadge status="stopped" />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("falls back to pending for unknown status", () => {
    render(<StatusBadge status="unknown-status" />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("applies additional className when provided", () => {
    const { container } = render(<StatusBadge status="completed" className="custom-class" />);
    const badge = container.querySelector(".custom-class");
    expect(badge).toBeInTheDocument();
  });

  it("applies correct CSS classes for running status", () => {
    const { container } = render(<StatusBadge status="running" />);
    const badge = container.querySelector(".bg-primary\\/15");
    expect(badge).toBeInTheDocument();
  });

  it("applies correct CSS classes for failed status", () => {
    const { container } = render(<StatusBadge status="failed" />);
    const badge = container.querySelector(".bg-destructive\\/15");
    expect(badge).toBeInTheDocument();
  });
});
