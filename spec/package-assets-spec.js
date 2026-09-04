const fs = require("fs");
const path = require("path");

describe("file-operations package assets", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  it("declares the executor service and the standard package test command", () => {
    expect(manifest.engines).toEqual({ lumine: "^1.0.0" });
    expect(manifest.scripts.test).toBe("lumine --test spec");
    expect(manifest.providedServices["file-operations.executor"].versions).toEqual({
      "1.0.0": "provideFileOperationsExecutor",
    });
  });

  it("keeps the canonical description in the manifest and README", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme.split(/\r?\n/)[2]).toBe(manifest.description);
    expect(manifest.description.endsWith(".")).toBe(true);
  });

  it("ships every runtime and service-documentation path", () => {
    for (const filePath of [
      "lib/main.js",
      "lib/main.d.ts",
      "lib/executor.js",
      "docs/file-operations.executor.md",
    ]) {
      expect(fs.existsSync(path.join(root, filePath))).toBe(true, filePath);
    }
  });
});
