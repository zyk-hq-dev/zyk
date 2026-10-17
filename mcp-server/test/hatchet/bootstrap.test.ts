import { describe, expect, it } from "vitest";
import { resolveAdminCredentials } from "../../src/hatchet/bootstrap.js";

describe("resolveAdminCredentials", () => {
  it("uses the local-dev defaults for a local Hatchet", () => {
    for (const url of ["http://localhost:8080", "http://127.0.0.1:8080"]) {
      expect(resolveAdminCredentials(url, {})).toEqual({
        email: "admin@example.com",
        password: "Admin123!!",
      });
    }
  });

  it("prefers configured credentials, even locally", () => {
    const env = { HATCHET_ADMIN_EMAIL: "a@b.c", HATCHET_ADMIN_PASSWORD: "s3cret" };
    expect(resolveAdminCredentials("http://localhost:8080", env)).toEqual({
      email: "a@b.c",
      password: "s3cret",
    });
  });

  it("refuses the defaults for a remote Hatchet and says what to set", () => {
    expect(() => resolveAdminCredentials("https://hatchet.example.com", {})).toThrow(
      /HATCHET_ADMIN_EMAIL and HATCHET_ADMIN_PASSWORD must be set/
    );
    expect(() =>
      resolveAdminCredentials("https://hatchet.example.com", { HATCHET_ADMIN_EMAIL: "a@b.c" })
    ).toThrow(/must be set/);
  });

  it("accepts configured credentials for a remote Hatchet", () => {
    const env = { HATCHET_ADMIN_EMAIL: "a@b.c", HATCHET_ADMIN_PASSWORD: "s3cret" };
    expect(resolveAdminCredentials("https://hatchet.example.com", env)).toEqual({
      email: "a@b.c",
      password: "s3cret",
    });
  });
});
