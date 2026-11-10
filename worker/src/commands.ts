import type { CommandMessage, Env, Finding, ResponseReason } from "./types";
import {
  COMMAND_PERMISSIONS,
  InstallationToken,
  classify,
  type ActorClass,
} from "./github";
import { installation, covers } from "./webhooks";
import { recordFeedback } from "./feedback";
import { lineageId } from "./lineage";
import { RESPONSE_REASONS } from "./validation";
import { redact } from "./redaction";
import { repositoryKey } from "./pulls";
import { reflectDismissal, GitHubHost } from "./publish";

// `/rio review` and `/rio dismiss <id> <reason>` (pr-publishing). The actor is
// classified through the collaborator permission API with an installation
// token, never from the payload. Results are reactions and comment edits,
// never new comments.

export type Command =
  | { kind: "review" }
  | { kind: "dismiss"; id: string; reason: ResponseReason; note?: string }
  | { kind: "invalid" };

/** Parses the first line of a comment body; anything else is invalid. */
export function parseCommand(body: string): Command {
  const line = body.trimStart().split("\n")[0].trim();
  const words = line.split(/\s+/);
  if (words[0] !== "/rio") return { kind: "invalid" };
  if (words[1] === "review" && words.length === 2) return { kind: "review" };
  if (words[1] === "dismiss" && words.length >= 4) {
    const [id, reason] = [words[2].toLowerCase(), words[3]];
    if (
      /^[a-f0-9]{8,64}$/.test(id) &&
      (RESPONSE_REASONS as readonly string[]).includes(reason)
    ) {
      const note = words.slice(4).join(" ").slice(0, 4000);
      return {
        kind: "dismiss",
        id,
        reason: reason as ResponseReason,
        ...(note ? { note } : {}),
      };
    }
  }
  return { kind: "invalid" };
}

/** The single posted finding of the PR lineage's current generation matching a prefix. */
export async function resolvePrefix(
  env: Env,
  tenant: string,
  lineage: string,
  prefix: string,
): Promise<{ identity: string; finding: Finding } | null> {
  if (prefix.length < 8) return null;
  const rows = await env.DB.prepare(
    "SELECT f.identity,f.finding_json FROM findings f JOIN lineages l ON l.id=f.lineage_id AND l.generation=f.generation WHERE f.tenant=? AND f.lineage_id=? AND f.first_posted_in IS NOT NULL AND substr(f.identity,1,?)=? LIMIT 2",
  )
    .bind(tenant, lineage, prefix.length, prefix)
    .all<{ identity: string; finding_json: string }>();
  if (rows.results.length !== 1) return null;
  return {
    identity: rows.results[0].identity,
    finding: JSON.parse(rows.results[0].finding_json).finding,
  };
}

export async function handleCommand(
  env: Env,
  message: CommandMessage,
): Promise<{ applied: boolean; actor?: ActorClass }> {
  const row = await installation(env, message.installation_id);
  if (!row || !covers(row, message.repository)) return { applied: false };
  const command = parseCommand(message.body);
  const token = await InstallationToken.mint(
    env,
    message.installation_id,
    message.repository,
    COMMAND_PERMISSIONS,
  );
  try {
    const host = new GitHubHost(
      token,
      message.repository,
      message.number,
      "",
      "",
    );
    const react = (content: "+1" | "-1") =>
      host.react(message.comment_id, content);
    // Every command that is not applied gets the same reaction.
    if (command.kind === "invalid") {
      await react("-1");
      return { applied: false };
    }
    const permission = await token.request(
      "GET",
      `/repos/${message.repository}/collaborators/${encodeURIComponent(message.actor)}/permission`,
    );
    const actor = classify(permission);
    if (command.kind === "review") {
      if (actor !== "maintainer") {
        console.log(
          `rio: ignored /rio review from ${message.actor} (${actor}) on ${message.repository}#${message.number}`,
        );
        await react("-1");
        return { applied: false, actor };
      }
      await react("+1");
      // A maintainer's request resets the lineage and escalates a fork PR.
      await env.JOBS.send({
        type: "review-request",
        tenant: message.tenant,
        installation_id: message.installation_id,
        repository: message.repository,
        number: message.number,
        trigger: "command",
        comment_id: message.comment_id,
      });
      return { applied: true, actor };
    }
    if (actor === "other") {
      console.log(
        `rio: ignored /rio dismiss from ${message.actor} (not a collaborator) on ${message.repository}#${message.number}`,
      );
      await react("-1");
      return { applied: false, actor };
    }
    const lineage = {
      repository: repositoryKey(message.repository),
      kind: "pr" as const,
      ref: String(message.number),
    };
    const match = await resolvePrefix(
      env,
      message.tenant,
      lineageId(message.tenant, lineage),
      command.id,
    );
    if (!match) {
      await react("-1");
      return { applied: false, actor };
    }
    const response = await recordFeedback(env, message.tenant, match.identity, {
      reason: command.reason,
      actor: message.actor,
      lineage,
      ...(command.note ? { note: command.note } : {}),
    });
    if (!response) {
      await react("-1");
      return { applied: false, actor };
    }
    // The answer is recorded; the reaction and the comment edit are
    // best-effort, so a GitHub failure never makes the queue record it twice.
    // The next publication applies the answer to the comment anyway.
    try {
      await react("+1");
      await reflectDismissal(
        env,
        token,
        {
          tenant: message.tenant,
          lineage: lineageId(message.tenant, lineage),
          repository: message.repository,
          number: message.number,
          installation: message.installation_id,
        },
        match.finding,
        response,
      );
    } catch (error) {
      console.log(
        `rio: /rio dismiss recorded for ${message.repository}#${message.number}, but its GitHub update failed: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      );
    }
    return { applied: true, actor };
  } finally {
    await token.revoke();
  }
}
