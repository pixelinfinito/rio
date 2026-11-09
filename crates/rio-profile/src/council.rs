use std::{collections::BTreeSet, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{ModuleKind, parse_duration, resolve_module};

/// Provider, model and family of a member that `rio init` has not configured.
pub const PLACEHOLDER: &str = "placeholder";

/// The five built-in members, in the order the report lists them.
pub const DEFAULT_MEMBERS: [&str; 5] = [
    "rio/council-skeptic",
    "rio/council-exploit-author",
    "rio/council-code-owner",
    "rio/council-maintainer",
    "rio/council-tester",
];

/// A profile's reference to a member module, with optional overrides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemberRef {
    pub uses: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_hosted: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Council {
    pub members: Vec<MemberRef>,
    pub max_findings: u64,
    pub max_experiments: u64,
    pub max_rounds: u64,
    pub min_members: u64,
    pub timeout: String,
    pub vendors_allowed: Vec<String>,
}

impl Council {
    /// The block's defaults, applied under whatever the profile sets.
    pub fn defaults() -> Value {
        json!({
            "members": DEFAULT_MEMBERS.iter().map(|uses| json!({"uses": uses})).collect::<Vec<_>>(),
            "max_findings": 5,
            "max_experiments": 2,
            "max_rounds": 2,
            "min_members": 3,
            "timeout": "90s",
            "vendors_allowed": [],
        })
    }
}

/// A member module with the profile's overrides applied; resolved-only data the
/// endpoint reads, outside the source profile schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedMember {
    pub name: String,
    pub version: String,
    pub role: String,
    pub context_pack: String,
    pub provider: String,
    pub model: String,
    /// Derived from `provider`; checked against both vendor allowlists.
    pub vendor: String,
    pub family: String,
    pub weight: f64,
    pub self_hosted: bool,
    /// The gateway route when an allowlist entry filled the member; otherwise
    /// the route is `provider/model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

impl ResolvedMember {
    pub fn configured(&self) -> bool {
        [&self.provider, &self.model, &self.family]
            .iter()
            .all(|value| value.as_str() != PLACEHOLDER)
    }
}

/// Resolve the members of a council, filling placeholders from the configured
/// allowlist; diagnostics are returned as (pointer, message).
pub fn resolve_members(
    council: &Council,
    vendors: &[VendorEntry],
    enabled: bool,
) -> Result<Vec<ResolvedMember>, Vec<(String, String)>> {
    let mut members: Vec<ResolvedMember> = Vec::new();
    let mut errors = Vec::new();
    for (index, reference) in council.members.iter().enumerate() {
        let pointer = format!("/council/members/{index}/uses");
        match resolve_module(&reference.uses) {
            Ok(module) => match (&module.kind, &module.member) {
                (ModuleKind::Member, Some(fields)) => {
                    let provider = reference
                        .provider
                        .clone()
                        .unwrap_or(fields.provider.clone());
                    members.push(ResolvedMember {
                        name: module.name.clone(),
                        version: module.version.clone(),
                        role: fields.role.clone(),
                        context_pack: fields.context_pack.clone(),
                        vendor: provider.clone(),
                        provider,
                        model: reference.model.clone().unwrap_or(fields.model.clone()),
                        family: reference.family.clone().unwrap_or(fields.family.clone()),
                        weight: fields.weight,
                        self_hosted: reference.self_hosted.unwrap_or(fields.self_hosted),
                        route: None,
                    });
                }
                _ => errors.push((
                    pointer,
                    "uses must reference a council member module".into(),
                )),
            },
            Err(error) => errors.push((pointer, error.diagnostics[0].message.clone())),
        }
    }
    // Roles name members in round 2, the report and the audit: one each.
    for (index, member) in members.iter().enumerate() {
        if members[..index].iter().any(|m| m.role == member.role) {
            errors.push((
                format!("/council/members/{index}/uses"),
                format!("council role {} appears more than once", member.role),
            ));
        }
    }
    if council.min_members > council.members.len() as u64 {
        errors.push((
            "/council/min_members".into(),
            format!(
                "min_members {} exceeds the council's {} members",
                council.min_members,
                council.members.len()
            ),
        ));
    }
    if let Err(message) = parse_duration(&council.timeout) {
        errors.push(("/council/timeout".into(), message));
    }
    fill_placeholders(&mut members, vendors);
    // A disabled council (as in rio/base) makes no call, so its composition
    // cannot invalidate the profile.
    if errors.is_empty()
        && enabled
        && let Some(message) = diversity_error(&members)
    {
        errors.push(("/council/members".into(), message));
    }
    if errors.is_empty() {
        Ok(members)
    } else {
        Err(errors)
    }
}

/// A fully configured council must span at least three model families; a
/// council with placeholders is unconfigured, not invalid.
pub fn diversity_error(members: &[ResolvedMember]) -> Option<String> {
    if members.iter().any(|member| !member.configured()) {
        return None;
    }
    let families: BTreeSet<_> = members
        .iter()
        .map(|member| member.family.as_str())
        .collect();
    (families.len() < 3).then(|| {
        format!(
            "council members span {} model {} ({}); at least three are required",
            families.len(),
            if families.len() == 1 {
                "family"
            } else {
                "families"
            },
            families.into_iter().collect::<Vec<_>>().join(", ")
        )
    })
}

/// Lines that `rio profile validate` and `rio profile show` print about an
/// enabled council: unconfigured members and a council that will be skipped.
pub fn council_status(council: &Council, members: &[ResolvedMember]) -> Vec<String> {
    let mut lines: Vec<String> = members
        .iter()
        .filter(|member| !member.configured())
        .map(|member| {
            format!(
                "council member {} ({}) is unconfigured; run `rio init` to choose council vendors",
                member.name, member.role
            )
        })
        .collect();
    let any_self_hosted = members.iter().any(|member| member.self_hosted);
    if council.vendors_allowed.is_empty() && !any_self_hosted {
        lines.push(
            "council.vendors_allowed is empty and no member is self-hosted; the council step will be skipped"
                .into(),
        );
    }
    lines
}

/// One entry of the council allowlist that `rio init` writes to `config.toml`
/// (`[[deployment.council_vendors]]`) and to the endpoint (`COUNCIL_VENDORS`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VendorEntry {
    pub vendor: String,
    pub family: String,
    /// The gateway route, `provider/model`.
    pub model: String,
}

impl VendorEntry {
    pub fn validate(&self) -> Result<(), String> {
        let slug = |value: &str| {
            value.starts_with(|c: char| c.is_ascii_lowercase())
                && value
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        };
        if !slug(&self.vendor) || !slug(&self.family) {
            return Err("council vendor and family must be lowercase slugs".into());
        }
        match self.model.split_once('/') {
            Some((provider, model))
                if !provider.is_empty()
                    && !model.is_empty()
                    && !self.model.chars().any(char::is_whitespace) =>
            {
                Ok(())
            }
            _ => Err(format!(
                "council model {:?} must be a provider/model route",
                self.model
            )),
        }
    }
}

/// The council allowlist saved in the user configuration; empty when absent.
pub fn configured_vendors(config_dir: &Path) -> Result<Vec<VendorEntry>, String> {
    let text = match std::fs::read_to_string(config_dir.join("config.toml")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let value: toml::Value = toml::from_str(&text).map_err(|error| error.to_string())?;
    let Some(entries) = value
        .get("deployment")
        .and_then(|deployment| deployment.get("council_vendors"))
    else {
        return Ok(Vec::new());
    };
    let entries: Vec<VendorEntry> = entries
        .clone()
        .try_into()
        .map_err(|error: toml::de::Error| error.to_string())?;
    for entry in &entries {
        entry.validate()?;
    }
    Ok(entries)
}

/// Fill placeholder members from the allowlist, taking entries in turn across
/// families so the members spread over as many families as the list offers.
/// The Worker applies the same rule with the endpoint's allowlist.
pub fn fill_placeholders(members: &mut [ResolvedMember], entries: &[VendorEntry]) {
    let mut families: Vec<&str> = Vec::new();
    for entry in entries {
        if !families.contains(&entry.family.as_str()) {
            families.push(&entry.family);
        }
    }
    if families.is_empty() {
        return;
    }
    let mut used = std::collections::BTreeMap::<&str, usize>::new();
    for (next, member) in members
        .iter_mut()
        .filter(|member| !member.configured())
        .enumerate()
    {
        let family = families[next % families.len()];
        let pool: Vec<_> = entries.iter().filter(|e| e.family == family).collect();
        let n = used.entry(family).or_default();
        let entry = pool[*n % pool.len()];
        *n += 1;
        member.provider = entry.vendor.clone();
        member.vendor = entry.vendor.clone();
        member.family = entry.family.clone();
        member.model = entry.model.clone();
        member.route = Some(entry.model.clone());
        member.self_hosted = false;
    }
}
