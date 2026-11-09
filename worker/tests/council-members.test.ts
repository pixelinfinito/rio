import { describe, expect, it } from "vitest";
import {
  authorFamily,
  compose,
  councilVendors,
  type Member,
  type Role,
  type VendorEntry,
} from "../src/council";

const member = (
  role: Role,
  vendor = "placeholder",
  family = vendor,
): Member => ({
  name: `rio/council-${role}`,
  version: "0.1.0",
  role,
  context_pack: "diff-only",
  provider: vendor,
  model: vendor === "placeholder" ? "placeholder" : `${family}-model`,
  vendor,
  family,
  weight: 1,
  self_hosted: false,
});
const entry = (vendor: string, family: string): VendorEntry => ({
  vendor,
  family,
  model: `${vendor}/${family}-model`,
});
const allowAll = { vendors_allowed: ["anthropic", "openai", "google"] };

describe("repository council allowlist", () => {
  it("reads a list, a per-repository object with a fallback, and nothing", () => {
    const list = [entry("openai", "gpt")];
    expect(councilVendors(JSON.stringify(list), "github.com/o/r")).toEqual(
      list,
    );
    const keyed = JSON.stringify({
      "github.com/o/r": [entry("google", "gemini")],
      "*": list,
    });
    expect(councilVendors(keyed, "github.com/o/r")[0].vendor).toBe("google");
    expect(councilVendors(keyed, "github.com/o/other")).toEqual(list);
    expect(councilVendors(undefined, "github.com/o/r")).toEqual([]);
    expect(() =>
      councilVendors(JSON.stringify([{ vendor: "x", model: "nope" }]), null),
    ).toThrow("COUNCIL_VENDORS entries");
  });
});

describe("double vendor allowlist", () => {
  const members = [
    member("skeptic", "openai", "gpt"),
    member("tester", "google", "gemini"),
  ];
  it("excludes a vendor missing from the repository allowlist", () => {
    const result = compose(
      members,
      allowAll,
      [entry("openai", "gpt")],
      null,
      false,
    );
    expect(result.participants.map((m) => m.role)).toEqual(["skeptic"]);
    expect(result.excluded).toEqual([
      { role: "tester", vendor: "google", denied_by: "repository" },
    ]);
  });
  it("excludes a vendor missing from the profile allowlist", () => {
    const result = compose(
      members,
      { vendors_allowed: ["openai"] },
      [entry("openai", "gpt"), entry("google", "gemini")],
      null,
      false,
    );
    expect(result.excluded).toEqual([
      { role: "tester", vendor: "google", denied_by: "profile" },
    ]);
  });
  it("runs only self-hosted members under an empty profile allowlist", () => {
    const local = {
      ...member("maintainer", "local", "llama"),
      self_hosted: true,
    };
    const result = compose(
      [...members, local],
      { vendors_allowed: [] },
      [],
      null,
      true,
    );
    expect(result.participants.map((m) => m.role)).toEqual(["maintainer"]);
    expect(result.excluded.map((e) => e.denied_by)).toEqual([
      "profile",
      "profile",
    ]);
    expect(
      compose([local], { vendors_allowed: [] }, [], null, false).excluded,
    ).toEqual([{ role: "maintainer", vendor: "local", denied_by: "runner" }]);
  });
  it("fills placeholders across the allowlist's families", () => {
    const roles: Role[] = [
      "skeptic",
      "exploit-author",
      "code-owner",
      "maintainer",
      "tester",
    ];
    const result = compose(
      roles.map((r) => member(r)),
      allowAll,
      [
        entry("anthropic", "claude"),
        entry("openai", "gpt"),
        entry("google", "gemini"),
      ],
      null,
      false,
    );
    expect(result.participants.map((m) => m.family)).toEqual([
      "claude",
      "gpt",
      "gemini",
      "claude",
      "gpt",
    ]);
    expect(result.participants[0].route).toBe("anthropic/claude-model");
    expect(
      compose([member("skeptic")], allowAll, [], null, false).unconfigured,
    ).toEqual(["skeptic"]);
  });
});

describe("author-family rule", () => {
  const council = [
    member("skeptic", "anthropic", "claude"),
    member("exploit-author", "anthropic", "claude"),
    member("code-owner", "openai", "gpt"),
    member("maintainer", "openai", "gpt"),
    member("tester", "openai", "gpt"),
  ];
  it("reads the family from agent attribution", () => {
    expect(authorFamily({ name: "Claude" })).toBe("claude");
    expect(authorFamily({ name: "chatgpt-codex-connector[bot]" })).toBe("gpt");
    expect(authorFamily({ name: "google-labs-jules[bot]" })).toBe("gemini");
    expect(authorFamily({ name: "Copilot" })).toBeNull();
    expect(authorFamily(undefined)).toBeNull();
  });
  it("substitutes a second member of the author's family from the allowlist", () => {
    const result = compose(
      council,
      allowAll,
      [
        entry("anthropic", "claude"),
        entry("openai", "gpt"),
        entry("google", "gemini"),
      ],
      "claude",
      false,
    );
    expect(result.participants.map((m) => [m.role, m.family])).toEqual([
      ["skeptic", "claude"],
      ["exploit-author", "gemini"],
      ["code-owner", "gpt"],
      ["maintainer", "gpt"],
      ["tester", "gpt"],
    ]);
    expect(result.author_family).toEqual({
      status: "applied",
      family: "claude",
      substituted: [
        { role: "exploit-author", vendor: "google", family: "gemini" },
      ],
    });
  });
  it("drops the member and runs partial when no other family is allowlisted", () => {
    const local = (role: Role) => ({
      ...member(role, "local", "llama"),
      self_hosted: true,
    });
    const result = compose(
      [
        local("skeptic"),
        local("exploit-author"),
        member("code-owner", "openai", "gpt"),
        local("maintainer"),
        member("tester", "openai", "gpt"),
      ],
      allowAll,
      [entry("openai", "gpt")],
      "gpt",
      true,
    );
    expect(result.participants.map((m) => m.role)).toEqual([
      "skeptic",
      "exploit-author",
      "code-owner",
      "maintainer",
    ]);
    expect(result.author_family).toEqual({
      status: "applied",
      family: "gpt",
      dropped: ["tester"],
    });
  });
  it("is not applicable without author metadata", () => {
    const result = compose(
      council,
      allowAll,
      [entry("anthropic", "claude"), entry("openai", "gpt")],
      null,
      false,
    );
    expect(result.participants).toHaveLength(5);
    expect(result.author_family).toEqual({ status: "not_applicable" });
  });
});

describe("review fixes: routing and the wildcard allowlist", () => {
  it("excludes a member whose route is not its vendor's allowlist entry", () => {
    const smuggled = {
      ...member("skeptic", "openai", "gpt"),
      route: "anthropic/test",
    };
    const result = compose(
      [smuggled],
      { vendors_allowed: ["openai"] },
      [entry("openai", "gpt")],
      null,
      false,
    );
    expect(result.participants).toEqual([]);
    expect(result.excluded).toEqual([
      { role: "skeptic", vendor: "openai", denied_by: "repository" },
    ]);
  });
  it("takes the vendor from the provider when no route is given", () => {
    const labelled = {
      ...member("skeptic", "anthropic", "claude"),
      vendor: "openai",
    };
    const result = compose(
      [labelled],
      { vendors_allowed: ["openai"] },
      [entry("openai", "gpt")],
      null,
      false,
    );
    expect(result.excluded).toEqual([
      { role: "skeptic", vendor: "anthropic", denied_by: "profile" },
    ]);
  });
  it("uses the wildcard entry for reviews without a repository", () => {
    const list = [entry("openai", "gpt")];
    expect(councilVendors(JSON.stringify({ "*": list }), null)).toEqual(list);
  });
});

describe("second review: exact routes", () => {
  it("excludes a nested route that is not an allowlist entry", () => {
    const nested = {
      ...member("skeptic", "openai", "gpt"),
      model: "custom-blocked/private-model",
    };
    const result = compose(
      [nested],
      { vendors_allowed: ["openai"] },
      [{ vendor: "openai", family: "gpt", model: "openai/allowed-model" }],
      null,
      false,
    );
    expect(result.participants).toEqual([]);
    expect(result.excluded[0].denied_by).toBe("repository");
  });
});
