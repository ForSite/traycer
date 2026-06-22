import { describe, expect, it } from "vitest";
import { serviceLabelFor, windowsTaskName } from "../label";

describe("serviceLabelFor", () => {
  it("uses the production service label for production", () => {
    const label = serviceLabelFor("production");

    expect(label).toEqual({
      id: "ai.traycer.host",
      displayName: "Traycer Host",
      environment: "production",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host");
  });

  it("gives the dev environment its own service slot", () => {
    const label = serviceLabelFor("dev");

    expect(label).toEqual({
      id: "ai.traycer.host.dev",
      displayName: "Traycer Host (Dev)",
      environment: "dev",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Dev");
  });

  it("gives each non-production environment its own isolated slot", () => {
    const label = serviceLabelFor("staging");

    expect(label).toEqual({
      id: "ai.traycer.host.staging",
      displayName: "Traycer Host (Staging)",
      environment: "staging",
    });
    expect(windowsTaskName(label)).toBe("\\Traycer\\Host-Staging");
  });
});
