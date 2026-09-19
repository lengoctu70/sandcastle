import { describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("listSandboxProviders returns host, docker and podman", () => {
    const providers = listSandboxProviders();
    expect(providers.map((p) => p.name)).toEqual(["host", "docker", "podman"]);
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
