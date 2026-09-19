import { describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns host, docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.map((p) => p.name)).toEqual(["host", "docker", "podman"]);
  });

  it("lists host first and marks it recommended for the interactive picker", () => {
    // ADR 0021: the subscription-reusing host path leads the picker and
    // carries the "(khuyến nghị)" marker + initial value.
    const providers = listSandboxProviders();
    expect(providers[0]!.name).toBe("host");
    expect(providers[0]!.recommended).toBe(true);
    // Exactly one recommended entry — the marker is unambiguous.
    expect(providers.filter((p) => p.recommended === true)).toHaveLength(1);
    // Container paths are still offered, just not marked.
    expect(providers.slice(1).every((p) => p.recommended !== true)).toBe(true);
  });

  it("getSandboxProvider returns a host entry with no image capability", () => {
    const provider = getSandboxProvider("host");
    expect(provider).toBeDefined();
    expect(provider!.runsOnHost).toBe(true);
    expect(provider!.containerfileName).toBeUndefined();
    expect(provider!.cliNamespace).toBeUndefined();
    expect(provider!.codegen.factoryImport).toBe("noSandbox");
    expect(provider!.codegen.importSubpath).toBe("no-sandbox");
    expect(provider!.codegen.runBranchStrategy).toBe(
      '{ type: "merge-to-head" }',
    );
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns podman entry", () => {
    const provider = getSandboxProvider("podman");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Containerfile");
    expect(provider!.cliNamespace).toBe("podman");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
